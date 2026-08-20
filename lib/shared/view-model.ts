/**
 * View-models: the shapes the pages actually want. Ported from
 * public/js/ui/model.js.
 *
 * Pages never walk `env.repos` or filter claims themselves — they ask for a row.
 * That keeps "what counts as held" in one place, and means a change to the data
 * layer lands here rather than in seven page files.
 *
 * Pure functions over data the caller already loaded, so these run on the server
 * inside a Server Component and need no database access of their own.
 */

import { displayStatus, repoClaims } from "./occupancy";
import type {
  Account,
  Claim,
  DirectoryUser,
  EnvStatus,
  Environment,
  JiraIssue,
  RepoHealth,
  ServerRepo,
} from "@/lib/types";

export interface Person {
  id: string;
  name: string;
  /** Resolved through this person's linked login, because a picture is uploaded
   *  by a login. Null for most of the board, which has no login at all — the
   *  same "read through the link" rule jiraNames already follows. */
  avatarUrl?: string | null;
  /** A Jira label that matched nobody in the directory. Half the point of
   *  showing it: a label with no person behind it is a ticket nobody can find
   *  as theirs. */
  unmatched?: boolean;
}

// ---------- time ----------

/** Minutes until a claim frees up, or null when it has no end time. */
export function minutesLeft(claim: { endTime?: string | null }, now = Date.now()): number | null {
  if (!claim.endTime) return null;
  return Math.floor((new Date(claim.endTime).getTime() - now) / 60000);
}

/** Sort key that keeps "no end time" at the bottom instead of first. */
export function nullsLast(minutes: number | null): number {
  return minutes === null ? Number.POSITIVE_INFINITY : minutes;
}

export function isUrgent(minutes: number | null): boolean {
  return minutes !== null && minutes <= 60;
}

export function leftText(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes <= 0) return "Expired";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How far through its booking a claim is, 0–100, for the progress bar. */
export function progress(claim: { startTime?: string | null; endTime?: string | null }, now = Date.now()): number {
  if (!claim.startTime || !claim.endTime) return 0;

  const start = new Date(claim.startTime).getTime();
  const end = new Date(claim.endTime).getTime();
  if (!(end > start)) return 100;

  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}

// ---------- environments ----------

export interface EnvRow {
  env: Environment;
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  state: EnvStatus;
  claims: Claim[];
  repos: ServerRepo[];
  freeRepos: string[];
  offline: string[];
  /** The claim that frees up first — the one the row reports on. */
  soonest: Claim | null;
  people: Person[];
  ticketIds: string[];
}

export function envRow(
  env: Environment,
  accounts: Account[],
  claims: Claim[],
  directory: DirectoryUser[],
  avatars?: Map<string, string>,
): EnvRow {
  const account = accounts.find((a) => a.id === env.accountId) ?? null;
  const mine = claims.filter((c) => c.serverId === env.id);

  const held = new Set(mine.flatMap((c) => c.repos));
  const withEnd = mine
    .filter((c) => c.endTime)
    .sort((a, b) => new Date(a.endTime!).getTime() - new Date(b.endTime!).getTime());

  return {
    env,
    id: env.id,
    name: env.name,
    accountId: env.accountId,
    accountName: account?.displayName ?? "—",
    state: displayStatus(env, claims),
    claims: mine,
    repos: env.repos,
    freeRepos: env.repos.map((r) => r.repoName).filter((r) => !held.has(r)),
    offline: env.repos.filter((r) => r.health === "offline").map((r) => r.repoName),
    soonest: withEnd[0] ?? null,
    people: peopleOf(mine, directory, avatars),
    ticketIds: [...new Set(mine.map((c) => c.id))],
  };
}

export function envRows(
  environments: Environment[],
  accounts: Account[],
  claims: Claim[],
  directory: DirectoryUser[],
  avatars?: Map<string, string>,
): EnvRow[] {
  return environments.map((env) => envRow(env, accounts, claims, directory, avatars));
}

/**
 * Everyone a set of claims is assigned to, resolved through the directory.
 *
 * Unmatched raw Jira labels are included as pseudo-people, so an environment
 * held by a label nobody recognises still shows *someone* rather than an empty
 * cell that reads as unassigned.
 */
export function peopleOf(
  claims: Claim[],
  directory: DirectoryUser[],
  /** From avatarVersions(). Optional so a caller that renders no faces — the
   *  badge counts, say — does not have to fetch it. */
  avatars?: Map<string, string>,
): Person[] {
  const byId = new Map<string, Person>();

  const faceFor = (person: DirectoryUser): string | null => {
    if (!avatars || !person.avatarUserId) return null;
    const version = avatars.get(person.avatarUserId);
    // The version is what makes the URL cacheable forever and still current.
    return version
      ? `/api/avatar/${person.avatarUserId}?v=${encodeURIComponent(version)}`
      : null;
  };

  for (const claim of claims) {
    for (const id of claim.userIds) {
      const person = directory.find((d) => d.id === id);
      if (person) {
        byId.set(person.id, { id: person.id, name: person.name, avatarUrl: faceFor(person) });
      } else {
        byId.set(id, { id, name: id, unmatched: true });
      }
    }
    for (const label of claim.rawAssignees) {
      const key = `raw:${label.trim().toLowerCase()}`;
      // Only if no directory person already covers this label — otherwise a
      // matched ticket would show the person and the label as two people.
      const known = directory.some(
        (d) =>
          d.name.trim().toLowerCase() === label.trim().toLowerCase() ||
          d.jiraNames.some((n) => n.trim().toLowerCase() === label.trim().toLowerCase()),
      );
      if (!known && !byId.has(key)) byId.set(key, { id: key, name: label, unmatched: true });
    }
  }

  return [...byId.values()];
}

// ---------- repositories (the health page) ----------

export interface RepoRow {
  serverId: string;
  env: string;
  accountName: string;
  repo: string;
  url: string | null;
  health: RepoHealth;
  healthCheckedAt: string | null;
  claims: Claim[];
  note: string | null;
}

/** A health page whose failures sit twenty rows down is not a health page. */
const HEALTH_RANK: Record<RepoHealth, number> = {
  offline: 0,
  checking: 1,
  unconfigured: 2,
  online: 3,
};

export function repoRows(environments: Environment[], accounts: Account[], claims: Claim[]): RepoRow[] {
  const rows: RepoRow[] = [];

  for (const env of environments) {
    const account = accounts.find((a) => a.id === env.accountId);
    for (const repo of env.repos) {
      rows.push({
        serverId: env.id,
        env: env.name,
        accountName: account?.displayName ?? "—",
        repo: repo.repoName,
        url: repo.url || null,
        health: repo.health,
        healthCheckedAt: repo.healthCheckedAt,
        claims: repoClaims(claims, env.id, repo.repoName),
        note: repo.note,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
      a.accountName.localeCompare(b.accountName) ||
      a.env.localeCompare(b.env) ||
      a.repo.localeCompare(b.repo),
  );
}

// ---------- claims and the wider board ----------

export interface TicketRow {
  claim: Claim;
  env: string;
  serverId: string | null;
  accountName: string;
  minutesLeft: number | null;
  people: Person[];
  /** True when this ticket is actually occupying repositories. The only thing
   *  that separates a claim row from a board row. */
  holding: boolean;
}

/** One row per ticket that IS holding repositories. Soonest to free first —
 *  the question people actually ask. */
export function claimRows(
  environments: Environment[],
  accounts: Account[],
  claims: Claim[],
  directory: DirectoryUser[],
  avatars?: Map<string, string>,
): TicketRow[] {
  return claims
    .map((claim) => {
      const env = environments.find((e) => e.id === claim.serverId) ?? null;
      const account = env ? accounts.find((a) => a.id === env.accountId) : null;

      return {
        claim,
        env: env?.name ?? claim.branch ?? "—",
        serverId: env?.id ?? null,
        accountName: account?.displayName ?? claim.accountName ?? "—",
        minutesLeft: minutesLeft(claim),
        people: peopleOf([claim], directory, avatars),
        holding: true,
      };
    })
    .sort((a, b) => nullsLast(a.minutesLeft) - nullsLast(b.minutesLeft));
}

/**
 * One row per ticket that is *not* holding a repository — everything the last
 * sync saw at any other status, from OPEN to CLOSED.
 *
 * Same shape as claimRows(), so a ticket table can list the two together. A
 * ticket Jira could not match to an environment still gets a row: it has a
 * status and an assignee, which is all the table needs.
 */
export function boardRows(
  issues: JiraIssue[],
  environments: Environment[],
  accounts: Account[],
  directory: DirectoryUser[],
  avatars?: Map<string, string>,
): TicketRow[] {
  return issues
    .map((issue) => {
      const env = issue.serverId ? (environments.find((e) => e.id === issue.serverId) ?? null) : null;
      const account = env ? accounts.find((a) => a.id === env.accountId) : null;

      const asClaim: Claim = {
        id: issue.key,
        source: "jira",
        serverId: issue.serverId ?? "",
        accountName: issue.accountName,
        branch: issue.branch,
        repos: issue.repos,
        userIds: issue.userIds,
        rawAssignees: issue.rawAssignees,
        status: issue.status,
        summary: issue.summary,
        note: null,
        startTime: issue.startTime,
        endTime: issue.endTime,
        claimedAt: "",
        lastSyncedAt: null,
      };

      return {
        claim: asClaim,
        env: env?.name ?? issue.branch ?? "—",
        serverId: env?.id ?? null,
        accountName: account?.displayName ?? issue.accountName ?? "—",
        minutesLeft: minutesLeft(issue),
        people: peopleOf([asClaim], directory, avatars),
        holding: false,
      };
    })
    .sort(
      (a, b) =>
        nullsLast(a.minutesLeft) - nullsLast(b.minutesLeft) || a.claim.id.localeCompare(b.claim.id),
    );
}

// ---------- filtering ----------

export interface EnvFilters {
  status?: string;
  account?: string;
  q?: string;
  /** Only environments held by the signed-in person. */
  mine?: boolean;
}

/**
 * Ported from State.getFilteredServers(). The haystack is deliberately wide —
 * people search for a ticket key, a repo URL or a colleague's name as readily as
 * for an environment name, and the legacy version searched all of them.
 */
export function filterEnvRows(
  rows: EnvRow[],
  filters: EnvFilters,
  mineIds?: Set<string>,
): EnvRow[] {
  const search = (filters.q ?? "").trim().toLowerCase();

  return rows.filter((row) => {
    if (filters.status && filters.status !== "all" && row.state !== filters.status) return false;
    if (filters.account && filters.account !== "all" && row.accountId !== filters.account) return false;
    if (filters.mine && mineIds && !row.claims.some((c) => mineIds.has(c.id))) return false;

    if (!search) return true;

    const haystack = [
      row.name,
      row.accountName,
      row.repos.map((r) => `${r.repoName} ${r.url}`).join(" "),
      row.repos.map((r) => r.note ?? "").join(" "),
      row.people.map((p) => p.name).join(" "),
      row.ticketIds.join(" "),
      row.claims.map((c) => c.summary ?? "").join(" "),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });
}

export function statusCounts(rows: EnvRow[]): Record<EnvStatus, number> {
  const counts: Record<EnvStatus, number> = { free: 0, partial: 0, inuse: 0, issue: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}
