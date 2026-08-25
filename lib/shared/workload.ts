/**
 * The roster: the board re-asked as "who is working on what, and who is free".
 *
 * Every other page here is organised by environment or by ticket. This one is
 * organised by **person**, which is the question a lead actually asks before
 * handing out work — and the reason `/team` exists at all.
 *
 * ── Why this is a pure function and not a query ──
 *
 * The plan for this file was a Postgres aggregate, in the spirit of
 * lib/db/queries/tickets.ts. It is not one, for two reasons:
 *
 *   1. **The inputs are bounded and already loaded.** The page needs getBoard()
 *      anyway (directory, environments, accounts, settings), which brings every
 *      claim with it. The other input is the Jira cache, and that is capped at
 *      MAX_PAGES * PAGE_SIZE = 500 rows by lib/jira/sync.ts over a 30-day
 *      window — it does not grow with the backlog the way the ticket *list*
 *      does. There is nothing here for LIMIT to save.
 *
 *   2. **It would have meant writing the assignee rule a third time.** SQL
 *      already reimplements claimIsMine() once, in tickets.ts, and that
 *      duplication costs a 103-check verify script to hold in place. A roster
 *      has to bucket *every* person rather than test one, so the SQL would have
 *      been a harder copy of a rule that is already the fiddliest thing in the
 *      app. Bucketing with claimIsMine() itself means the roster and the
 *      per-person drill-down (which pages through Postgres with that person's
 *      identity strings) cannot disagree — they are the same rule, run once
 *      each way.
 *
 * So: O(people x tickets) calls to claimIsMine, which at this board's size is a
 * few tens of thousands of string comparisons, against a rule that can only be
 * wrong in one place.
 *
 * ── What counts as "still working on it" ──
 *
 * `statusFrees()` from lib/jira/matching.ts, negated. That is invariant 2 —
 * only a releasing or terminal status lets go, and QA FAILED is still being
 * worked — so the roster's idea of live work is the same rule that decides
 * whether the claim is still held. Not a second status list.
 */

import { statusFrees } from "@/lib/jira/matching";
import { claimIsMine, directoryIdentityValues } from "./mine";
import { minutesLeft, personAvatarUrl, type Person, type TicketRow } from "./view-model";
import type { Availability, AuthUser, DirectoryUser, JiraSettings } from "@/lib/types";

export type { Availability };

/** Holding this many environments at once is where the roster stops saying
 *  "busy" and starts saying it louder. Named rather than sprinkled. */
export const OVERLOADED_AT = 3;


export interface WorkloadRow {
  person: Person;
  /** "Backend", "QA" — free text from the directory. Empty for a name nobody
   *  in the directory answers to. */
  jobRole: string;
  /** The login pointing at this person, for presence and last-seen. Null for
   *  most of the board: being assignable and being able to sign in are
   *  different things. */
  loginId: string | null;
  lastSeenAt: string | null;
  availability: Availability;
  /** Tickets holding repositories right now — the ones blocking somebody. */
  holding: TicketRow[];
  /** Assigned and live, but holding nothing. Work in flight without an
   *  environment: reviews, tickets waiting on a box, anything pre-QA. */
  open: TicketRow[];
  /** Assigned but finished — released or terminal. Counted, never listed: it is
   *  context for "they only look free because they just shipped", not a task. */
  doneCount: number;
  /** Distinct environments held, by name. */
  environments: string[];
  /** Distinct (environment, repository) pairs held. Two people on one
   *  environment is normal; this is the honest measure of what is occupied. */
  repoCount: number;
  /** Minutes until their first environment frees. Null when nothing they hold
   *  has an end time, which is not "soon" — it is unknown. */
  soonestFree: number | null;
  /** Held claims whose end time has already passed. */
  overdue: number;
}

export interface RosterSummary {
  people: number;
  free: number;
  assigned: number;
  /** Includes the overloaded — they are busy too. */
  busy: number;
  overloaded: number;
  /** Live tickets naming nobody at all. The other question a lead asks. */
  unassignedTickets: number;
  /** Names on tickets that no directory person answers to. */
  unmatchedNames: number;
}

export interface Roster {
  /** One per person in the directory, whether or not they have any work. */
  rows: WorkloadRow[];
  /**
   * Pseudo-rows for names nobody answers to — an unresolved Jira label, or a
   * claim pointing at a directory id that has since been deleted.
   *
   * Kept separate rather than dropped: a ticket assigned to a name the board
   * does not know is invisible on its real owner's My tickets page, and this is
   * the view where somebody can notice that. It is the same warning the Users
   * page raises, arrived at from the work side.
   */
  unmatched: WorkloadRow[];
  /** Live tickets with no assignee at all — nobody has picked these up. */
  unassigned: TicketRow[];
  summary: RosterSummary;
}

export interface RosterInput {
  directory: DirectoryUser[];
  /** Every ticket on the board: claimRows() followed by boardRows(). Both, or
   *  the roster reports holdings without the work that is not holding yet. */
  tickets: TicketRow[];
  jira: JiraSettings;
  /** From listAuthUsers(). Only for presence and last-seen — the roster is
   *  driven by the directory, not by who can sign in. */
  logins?: AuthUser[];
  /** From avatarVersions(). */
  avatars?: Map<string, string>;
}

/** Live work: anything a releasing or terminal status has not ended. */
export function isLive(row: TicketRow, jira: JiraSettings): boolean {
  return !statusFrees(jira, row.claim.status);
}

function availabilityOf(holding: number, open: number): Availability {
  if (holding >= OVERLOADED_AT) return "overloaded";
  if (holding > 0) return "busy";
  if (open > 0) return "assigned";
  return "free";
}

/** The per-person half, shared by the real rows and the unmatched pseudo-rows. */
function summarise(
  rows: TicketRow[],
  jira: JiraSettings,
  now: number,
): Pick<
  WorkloadRow,
  "availability" | "holding" | "open" | "doneCount" | "environments" | "repoCount" | "soonestFree" | "overdue"
> {
  const holding = rows.filter((row) => row.holding);
  const rest = rows.filter((row) => !row.holding);
  const open = rest.filter((row) => isLive(row, jira));

  const environments = [...new Set(holding.map((row) => row.env).filter((name) => name !== "—"))].sort();

  // Keyed on the environment too: "storefront" on two environments is two
  // occupied repositories, not one.
  const repos = new Set(
    holding.flatMap((row) => row.claim.repos.map((repo) => `${row.serverId ?? row.env}::${repo}`)),
  );

  const left = holding
    .map((row) => minutesLeft(row.claim, now))
    .filter((minutes): minutes is number => minutes !== null);

  return {
    availability: availabilityOf(holding.length, open.length),
    holding,
    open,
    doneCount: rest.length - open.length,
    environments,
    repoCount: repos.size,
    soonestFree: left.length ? Math.min(...left) : null,
    overdue: left.filter((minutes) => minutes <= 0).length,
  };
}

export function buildRoster(
  { directory, tickets, jira, logins = [], avatars }: RosterInput,
  now = Date.now(),
): Roster {
  const loginFor = new Map<string, AuthUser>();
  for (const login of logins) {
    if (login.directoryUserId) loginFor.set(login.directoryUserId, login);
  }

  // Computed once per person rather than once per (person, ticket): this is the
  // only allocation in the loop below that is worth hoisting.
  const identities = new Map<string, Set<string>>();
  for (const person of directory) identities.set(person.id, directoryIdentityValues(person));

  const buckets = new Map<string, TicketRow[]>();
  const unmatchedBuckets = new Map<string, { person: Person; rows: TicketRow[] }>();
  const unassigned: TicketRow[] = [];

  const push = (map: Map<string, TicketRow[]>, key: string, row: TicketRow) => {
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  };

  for (const row of tickets) {
    let named = false;

    for (const person of directory) {
      if (claimIsMine(row.claim, identities.get(person.id)!, directory)) {
        push(buckets, person.id, row);
        named = true;
      }
    }

    // Names nobody answers to. peopleOf() has already decided which those are —
    // it skips a raw label that a directory person covers, so what is left
    // flagged `unmatched` is exactly the set claimIsMine() could not reach.
    for (const person of row.people) {
      if (!person.unmatched) continue;
      const entry = unmatchedBuckets.get(person.id);
      if (entry) entry.rows.push(row);
      else unmatchedBuckets.set(person.id, { person, rows: [row] });
      named = true;
    }

    // A finished ticket with no assignee is not a gap, it is history.
    if (!named && isLive(row, jira)) unassigned.push(row);
  }

  const rows: WorkloadRow[] = directory.map((person) => {
    const login = loginFor.get(person.id) ?? null;

    return {
      person: {
        id: person.id,
        name: person.name,
        avatarUrl: personAvatarUrl(person, avatars),
      },
      jobRole: person.jobRole,
      loginId: login?.id ?? null,
      lastSeenAt: login?.lastSeenAt ?? null,
      ...summarise(buckets.get(person.id) ?? [], jira, now),
    };
  });

  const unmatched: WorkloadRow[] = [...unmatchedBuckets.values()].map(({ person, rows: theirs }) => ({
    person,
    jobRole: "",
    loginId: null,
    lastSeenAt: null,
    ...summarise(theirs, jira, now),
  }));

  const summary: RosterSummary = {
    people: rows.length,
    free: rows.filter((row) => row.availability === "free").length,
    assigned: rows.filter((row) => row.availability === "assigned").length,
    busy: rows.filter((row) => row.availability === "busy" || row.availability === "overloaded").length,
    overloaded: rows.filter((row) => row.availability === "overloaded").length,
    unassignedTickets: unassigned.length,
    unmatchedNames: unmatched.length,
  };

  return {
    rows: sortWorkloadRows(rows, undefined, undefined),
    unmatched: sortWorkloadRows(unmatched, undefined, undefined),
    unassigned,
    summary,
  };
}

// ---------- filtering and sorting ----------

export interface TeamFilters {
  /** An Availability, or "all" / undefined. */
  availability?: string;
  /** Free text over the name, the job role and the ticket keys they hold. */
  q?: string;
}

export function filterWorkloadRows(rows: WorkloadRow[], filters: TeamFilters): WorkloadRow[] {
  const availability = filters.availability && filters.availability !== "all" ? filters.availability : null;
  const q = filters.q?.trim().toLowerCase() ?? "";

  return rows.filter((row) => {
    // "busy" is the umbrella the summary tile uses, so the chip has to agree
    // with the number the person clicked.
    if (availability === "busy") {
      if (row.availability !== "busy" && row.availability !== "overloaded") return false;
    } else if (availability && row.availability !== availability) {
      return false;
    }

    if (!q) return true;

    return (
      row.person.name.toLowerCase().includes(q) ||
      row.jobRole.toLowerCase().includes(q) ||
      row.environments.some((env) => env.toLowerCase().includes(q)) ||
      [...row.holding, ...row.open].some(
        (ticket) =>
          ticket.claim.id.toLowerCase().includes(q) ||
          (ticket.claim.summary ?? "").toLowerCase().includes(q),
      )
    );
  });
}

/** How many rows each availability chip would show, given the search box. */
export function availabilityCounts(
  rows: WorkloadRow[],
  filters: TeamFilters,
): Record<Availability | "all" | "busyAll", number> {
  const matching = filterWorkloadRows(rows, { q: filters.q });
  const count = (state: Availability) => matching.filter((row) => row.availability === state).length;

  const busy = count("busy");
  const overloaded = count("overloaded");

  return {
    all: matching.length,
    free: count("free"),
    assigned: count("assigned"),
    busy,
    overloaded,
    busyAll: busy + overloaded,
  };
}

export const TEAM_SORTS = ["load", "name", "role", "frees"] as const;
export type TeamSort = (typeof TEAM_SORTS)[number];
export type SortDir = "asc" | "desc";

export function isTeamSort(value: string | undefined): value is TeamSort {
  return !!value && (TEAM_SORTS as readonly string[]).includes(value);
}

/** Busiest first, then most other work, then by name. The default, and the
 *  tiebreak under every other column. */
function byLoad(a: WorkloadRow, b: WorkloadRow): number {
  return (
    b.holding.length - a.holding.length ||
    b.repoCount - a.repoCount ||
    b.open.length - a.open.length ||
    a.person.name.localeCompare(b.person.name)
  );
}

/**
 * Order the rows. An unrecognised column falls back to the default rather than
 * throwing, because the sort comes from a URL anyone can edit.
 *
 * Following the Health page: "asc" means *the useful direction first*, not the
 * arithmetic one. The first click on Load shows the most loaded, because that is
 * what somebody sorting a roster by load is looking for.
 */
export function sortWorkloadRows(
  rows: WorkloadRow[],
  sort: string | undefined,
  dir: string | undefined,
): WorkloadRow[] {
  if (!isTeamSort(sort)) return [...rows].sort(byLoad);

  const flip = dir === "desc" ? -1 : 1;

  return [...rows].sort((a, b) => {
    let result = 0;

    switch (sort) {
      case "load":
        result = byLoad(a, b);
        break;
      case "name":
        result = a.person.name.localeCompare(b.person.name);
        break;
      case "role":
        // An empty job role is not the alphabetically-first role, it is the
        // absence of one — same reasoning as never-checked repositories on the
        // Health page. Returned before the flip so it stays last either way.
        if (!a.jobRole !== !b.jobRole) return a.jobRole ? -1 : 1;
        result = a.jobRole.localeCompare(b.jobRole);
        break;
      case "frees": {
        // "Holding nothing" is not "frees up first". Somebody with no
        // environment at all belongs at the bottom of a column about when
        // environments come back, in both directions.
        const idle = (a.soonestFree === null ? 1 : 0) - (b.soonestFree === null ? 1 : 0);
        if (idle !== 0) return idle;
        result = (a.soonestFree ?? 0) - (b.soonestFree ?? 0);
        break;
      }
    }

    return result * flip || byLoad(a, b);
  });
}
