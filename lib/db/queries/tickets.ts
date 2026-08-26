/**
 * One page of the ticket tables, sliced by Postgres rather than by JavaScript.
 *
 * The tables list two things concatenated: every claim that is holding a
 * repository, then every other issue the last sync saw. Those live in two tables
 * — `claims` and `jira_issues` — and the sync keeps them DISJOINT: a ticket is
 * recorded into the Jira cache only when it did not become a claim (the
 * `record()` versus `toClaim.push()` branches in lib/jira/sync.ts). So the page
 * is a plain concatenation and never needs de-duplicating.
 *
 * ── Why two queries and some arithmetic, not one UNION ALL ──
 *
 * Because every claim sorts before every issue, a page is either a slice of one
 * block or the tail of the first followed by the head of the second. Knowing how
 * many claims match is enough to work out which — so the counts come first, then
 * at most two plain LIMIT/OFFSET queries whose SQL reads like the unpaged ones
 * in ./board.ts. A UNION ALL of two differently-shaped tables would have to be
 * widened to a common column list and taken apart again on the way out.
 *
 * It also lets a query be SKIPPED when the page does not reach into that block:
 * page 1 of a board with 137 cached issues never touches `jira_issues` at all.
 *
 * ── Why OFFSET is safe here, when chat refuses it ──
 *
 * lib/db/queries/chat.ts pages by keyset and says why: a message arriving
 * mid-scroll shifts an OFFSET boundary. That is a stream read from one end. This
 * is a board re-read whole on each request, ordered by a countdown that has no
 * stable cursor to key on — see the header of lib/shared/pagination.ts.
 *
 * What OFFSET *does* require is a TOTAL order. Most rows here have no end_time
 * (they sort last, together), so `ORDER BY end_time` alone leaves ties Postgres
 * may break differently between two requests — which is precisely how OFFSET
 * pagination shows one row twice and drops another. Every ORDER BY below
 * therefore ends in a column that is unique.
 *
 * ── The two status filters, and why counting is now a GROUP BY ──
 *
 * `status` narrows to one, `hideStatuses` cuts several out, and like `mine`
 * both have to travel WITH the page: counting every status and then keeping ten
 * rows of one of them would number the pages off the wrong list.
 *
 * `hideStatuses` is the more interesting of the two, because it used to live
 * somewhere else entirely. `ignoredStatuses` was a `status NOT IN (…)` clause in
 * the sync's JQL, so those tickets were never fetched — which made Active
 * tickets tidy and made My tickets structurally unable to show somebody their
 * own closed or not-yet-started work. The rule is now applied here, per read:
 * Active tickets passes the list, My tickets passes nothing. ADR-014.
 *
 * The per-status figures the chip row needs are the SAME numbers the pager needs
 * once a status is picked, so both come out of one aggregate rather than out of
 * a separate count per filter state. That is why counting is a GROUP BY here and
 * no longer the pair of `count(*)` subqueries it used to be: it costs the same
 * round trip, and a chip reading 13 can no longer sit above a pager reading 12.
 * The hide list is applied to that aggregate too — a chip offering a status the
 * page would then refuse to show is worse than no chip.
 */

import { sql } from "@/lib/db/client";
import { JIRA_STATUS_VOCABULARY } from "@/lib/jira/matching";
import { TICKETS_PER_PAGE, pagePosition } from "@/lib/shared/pagination";
import type { PagePosition } from "@/lib/shared/pagination-types";
import { toClaim, toJiraIssue, type ClaimRow, type JiraIssueRow } from "./board";
import type { Claim, JiraIssue } from "@/lib/types";

/** One status, and how much of the list is sitting at it. */
export interface TicketStatusCount {
  /** The normalised key — what goes in `?status=`, and what the SQL compares. */
  key: string;
  /** The status as Jira spells it, for the chip label. */
  status: string;
  /** Claims at this status: the ones holding a repository. */
  holding: number;
  /** Cached issues at this status. */
  issues: number;
  total: number;
}

export interface TicketPage {
  /** Only the claims that fall on this page, in display order. */
  claims: Claim[];
  /** Only the cached issues that fall on this page, in display order. */
  issues: JiraIssue[];
  /** Every claim matching the query, not just this page: the sub-line under the
   *  page title reports on the whole list, not on the screenful. */
  holdingTotal: number;
  issueTotal: number;
  /**
   * Every status present in the list, in workflow order — and deliberately NOT
   * narrowed by the status filter. A chip row that re-counted itself under its
   * own filter would show the picked chip reading its total and every other
   * chip reading zero, so picking a second status would be impossible.
   */
  statuses: TicketStatusCount[];
  /** Clamped page number, pageCount, total, from, to. */
  position: PagePosition;
}

export interface TicketPageQuery {
  /** 1-based and NOT yet clamped — straight off `?page=`. */
  page: number;
  perPage?: number;
  /**
   * Restrict to one person's tickets: the lowercased strings that
   * identityValues() in lib/shared/mine.ts produces.
   *
   * Passing the values rather than a user id is deliberate. Deciding WHO
   * somebody is stays in that one function, which is the fiddly half; this
   * module only asks whether a ticket names any of the strings it was handed,
   * and that is the half which has to sit next to LIMIT so the count and the
   * page agree with each other.
   *
   * An empty array matches nothing, exactly as claimIsMine() is false for an
   * empty set. `null` or omitted means everybody's tickets.
   */
  mine?: string[] | null;
  /**
   * Restrict to one Jira status. Compared through statusKey(), so it can be
   * handed straight off `?status=` in whatever casing somebody typed. A status
   * nothing sits at yields an empty page rather than an error — the value comes
   * from a URL anyone can edit, which is the same rule pageNumber() follows.
   */
  status?: string | null;
  /**
   * Statuses to leave OUT — `settings.jira.ignoredStatuses`, which is what
   * Active tickets passes and My tickets deliberately does not.
   *
   * This used to be enforced in Jira, as a `status NOT IN (…)` clause in the
   * sync's JQL, and that is exactly what was wrong with it: a ticket at one of
   * these statuses was not hidden from the board, it was never fetched, so no
   * page could show it and My tickets could not answer "everything assigned to
   * me". Moving the rule here makes it a property of one READ. See ADR-014.
   *
   * Normalised through statusKey() by the caller or not at all — getTicketPage()
   * does it, so a list straight out of Settings ("DONE", "IN PROGRESS") works.
   */
  hideStatuses?: string[] | null;
}

/**
 * The status a row is filed under, normalised.
 *
 * Jira reports its own casing ("QA Testing (Stg)"), so the key is lowercased —
 * and an absent status becomes "unknown", which is what lib/jira/sync.ts already
 * writes when Jira sends no status name. Without that fallback a null status
 * would count into no chip at all while still being in the list, and the chips
 * would quietly stop adding up to the total.
 *
 * This is the JS twin of `lower(COALESCE(NULLIF(btrim(status), ''), 'Unknown'))`
 * below. The two must agree; verify:tickets checks that they do.
 */
export function statusKey(status: string | null | undefined): string {
  return (String(status ?? "").trim() || "Unknown").toLowerCase();
}

/*
 * ── On the `mine` predicate being written twice ──
 *
 * It mirrors claimIsMine(): the directory id, then the name that id resolves to
 * (falling back to the id itself when the directory does not know it — the `??
 * id` in that function), then a raw label nobody resolved. It is inlined into
 * each query below rather than factored out, because an interpolation into these
 * templates becomes a bind parameter, not SQL.
 *
 * Two duplications, one rule. scripts/verify-tickets.mts checks that the SQL and
 * claimIsMine() reach the same verdict for every row in the real database, which
 * is what keeps them from drifting.
 *
 * The status expression is repeated for the same reason and rather more times —
 * once per block in the aggregate, twice per page query. statusKey() is its JS
 * twin, and verify:tickets checks every copy against it the same way.
 *
 * One known narrowing: JS `.trim()` strips all Unicode whitespace, `btrim()`
 * strips spaces. A Jira display name with a leading tab would match in JS and
 * not here. The verify script would report it; no row in the board has one.
 */

/** The raw rows behind statusCounts(): one per status per block. */
interface StatusCountRow {
  block: "claim" | "issue";
  key: string;
  label: string;
  n: number;
}

/**
 * How many tickets sit at each status, both blocks, in one round trip.
 *
 * Not narrowed by `status` — this is the thing a status is chosen FROM. It IS
 * narrowed by `hide`, because a hidden status is not on this page's list at all
 * and a chip for one would offer a cut with nothing behind it. The totals the
 * pager needs are sums of these rows, which is what stops a chip and a pager
 * disagreeing.
 *
 * The `lower(...)` defeats `jira_issues_status_idx`, over a table lib/jira/sync.ts
 * caps at 500 rows. There is nothing here worth indexing around.
 */
async function statusCounts(
  mine: string[] | null,
  hide: string[] | null,
): Promise<TicketStatusCount[]> {
  const rows = (await sql`
    SELECT 'claim' AS block,
           lower(COALESCE(NULLIF(btrim(c.status), ''), 'Unknown')) AS key,
           max(COALESCE(NULLIF(btrim(c.status), ''), 'Unknown')) AS label,
           count(*)::int AS n
      FROM claims c
     WHERE (${mine}::text[] IS NULL
        OR EXISTS (
             SELECT 1 FROM claim_assignees ca
              WHERE ca.claim_id = c.id
                AND (lower(btrim(ca.directory_user_id)) = ANY(${mine}::text[])
                  OR lower(btrim(COALESCE(
                       (SELECT d.name FROM directory_users d WHERE d.id = ca.directory_user_id),
                       ca.directory_user_id))) = ANY(${mine}::text[]))
           )
        OR EXISTS (
             SELECT 1 FROM claim_raw_assignees ra
              WHERE ra.claim_id = c.id
                AND lower(btrim(ra.label)) = ANY(${mine}::text[])
           ))
       AND (${hide}::text[] IS NULL
        OR NOT (lower(COALESCE(NULLIF(btrim(c.status), ''), 'Unknown')) = ANY(${hide}::text[])))
     GROUP BY 1, 2

     UNION ALL

    SELECT 'issue' AS block,
           lower(COALESCE(NULLIF(btrim(j.status), ''), 'Unknown')) AS key,
           max(COALESCE(NULLIF(btrim(j.status), ''), 'Unknown')) AS label,
           count(*)::int AS n
      FROM jira_issues j
     WHERE (${mine}::text[] IS NULL
        OR EXISTS (
             SELECT 1 FROM unnest(j.user_ids) AS u
              WHERE lower(btrim(u)) = ANY(${mine}::text[])
                 OR lower(btrim(COALESCE(
                      (SELECT d.name FROM directory_users d WHERE d.id = u), u))) = ANY(${mine}::text[])
           )
        OR EXISTS (
             SELECT 1 FROM unnest(j.raw_assignees) AS r
              WHERE lower(btrim(r)) = ANY(${mine}::text[])
           ))
       AND (${hide}::text[] IS NULL
        OR NOT (lower(COALESCE(NULLIF(btrim(j.status), ''), 'Unknown')) = ANY(${hide}::text[])))
     GROUP BY 1, 2
  `) as StatusCountRow[];

  const byKey = new Map<string, TicketStatusCount>();

  for (const row of rows) {
    const entry = byKey.get(row.key) ?? {
      key: row.key,
      // Whichever block was seen first wins the spelling. The two only differ
      // if Jira is itself inconsistent about casing, and either is true.
      status: row.label,
      holding: 0,
      issues: 0,
      total: 0,
    };

    if (row.block === "claim") entry.holding += row.n;
    else entry.issues += row.n;
    entry.total += row.n;

    byKey.set(row.key, entry);
  }

  return [...byKey.values()].sort(compareStatuses);
}

/** Workflow order, so the chips read left to right the way a ticket moves. */
const STATUS_ORDER = new Map(
  JIRA_STATUS_VOCABULARY.map((status, index) => [status.toLowerCase(), index] as const),
);

/**
 * Statuses the team's workflow knows about first, in workflow order; anything
 * else after, biggest first.
 *
 * The board carries statuses that are not in the vocabulary — "Delivery Phase",
 * "Review & Finalization Phase" — because the vocabulary describes the sub-task
 * workflow and a parent issue has its own. Sorting those by size rather than
 * hiding them keeps the chips honest about what is actually in the list.
 */
function compareStatuses(a: TicketStatusCount, b: TicketStatusCount): number {
  const ai = STATUS_ORDER.get(a.key) ?? Number.POSITIVE_INFINITY;
  const bi = STATUS_ORDER.get(b.key) ?? Number.POSITIVE_INFINITY;
  if (ai !== bi) return ai - bi;
  if (a.total !== b.total) return b.total - a.total;
  return a.key.localeCompare(b.key);
}

const sum = (rows: TicketStatusCount[], field: "holding" | "issues"): number =>
  rows.reduce((total, row) => total + row[field], 0);

/**
 * Claims, soonest to free first.
 *
 * `end_time ASC NULLS LAST` is what lib/shared/view-model.ts spells nullsLast():
 * a claim with no end time is not urgent, it is unknown, and belongs at the
 * bottom rather than the top. `claimed_at DESC` then reproduces the order the
 * unpaged getClaims() hands to a stable JS sort, and `id` closes the tie for
 * good so OFFSET has a total order to walk.
 */
async function claimsPage(
  limit: number,
  offset: number,
  mine: string[] | null,
  status: string | null,
  hide: string[] | null,
): Promise<Claim[]> {
  if (limit <= 0) return [];

  const rows = (await sql`
    SELECT c.id, c.source, c.server_id, c.account_name, c.branch, c.status,
           c.summary, c.note, c.start_time, c.end_time, c.claimed_at, c.last_synced_at,
           c.jira_created_at, c.jira_updated_at,
           COALESCE(
             (SELECT array_agg(cr.repo_name ORDER BY cr.repo_name)
                FROM claim_repos cr WHERE cr.claim_id = c.id), '{}'
           ) AS repos,
           COALESCE(
             (SELECT array_agg(ca.directory_user_id ORDER BY ca.directory_user_id)
                FROM claim_assignees ca WHERE ca.claim_id = c.id), '{}'
           ) AS user_ids,
           COALESCE(
             (SELECT array_agg(ra.label ORDER BY ra.label)
                FROM claim_raw_assignees ra WHERE ra.claim_id = c.id), '{}'
           ) AS raw_assignees
      FROM claims c
     WHERE (${mine}::text[] IS NULL
        OR EXISTS (
             SELECT 1 FROM claim_assignees ca
              WHERE ca.claim_id = c.id
                AND (lower(btrim(ca.directory_user_id)) = ANY(${mine}::text[])
                  OR lower(btrim(COALESCE(
                       (SELECT d.name FROM directory_users d WHERE d.id = ca.directory_user_id),
                       ca.directory_user_id))) = ANY(${mine}::text[]))
           )
        OR EXISTS (
             SELECT 1 FROM claim_raw_assignees ra
              WHERE ra.claim_id = c.id
                AND lower(btrim(ra.label)) = ANY(${mine}::text[])
           ))
       AND (${status}::text IS NULL
        OR lower(COALESCE(NULLIF(btrim(c.status), ''), 'Unknown')) = ${status}::text)
       AND (${hide}::text[] IS NULL
        OR NOT (lower(COALESCE(NULLIF(btrim(c.status), ''), 'Unknown')) = ANY(${hide}::text[])))
     ORDER BY c.end_time ASC NULLS LAST, c.claimed_at DESC, c.id ASC
     LIMIT ${limit}::int OFFSET ${offset}::int
  `) as ClaimRow[];

  return rows.map(toClaim);
}

/** The Jira cache, same ordering rule, with `key` as the unique tiebreak — which
 *  is also the tiebreak boardRows() applies in JS. */
async function issuesPage(
  limit: number,
  offset: number,
  mine: string[] | null,
  status: string | null,
  hide: string[] | null,
): Promise<JiraIssue[]> {
  if (limit <= 0) return [];

  const rows = (await sql`
    SELECT j.key, j.server_id, j.account_name, j.branch, j.status, j.summary,
           j.start_time, j.end_time, j.repos, j.user_ids, j.raw_assignees,
           j.jira_created_at, j.jira_updated_at
      FROM jira_issues j
     WHERE (${mine}::text[] IS NULL
        OR EXISTS (
             SELECT 1 FROM unnest(j.user_ids) AS u
              WHERE lower(btrim(u)) = ANY(${mine}::text[])
                 OR lower(btrim(COALESCE(
                      (SELECT d.name FROM directory_users d WHERE d.id = u), u))) = ANY(${mine}::text[])
           )
        OR EXISTS (
             SELECT 1 FROM unnest(j.raw_assignees) AS r
              WHERE lower(btrim(r)) = ANY(${mine}::text[])
           ))
       AND (${status}::text IS NULL
        OR lower(COALESCE(NULLIF(btrim(j.status), ''), 'Unknown')) = ${status}::text)
       AND (${hide}::text[] IS NULL
        OR NOT (lower(COALESCE(NULLIF(btrim(j.status), ''), 'Unknown')) = ANY(${hide}::text[])))
     ORDER BY j.end_time ASC NULLS LAST, j.key ASC
     LIMIT ${limit}::int OFFSET ${offset}::int
  `) as JiraIssueRow[];

  return rows.map(toJiraIssue);
}

/**
 * One page of the ticket list.
 *
 * Counts first, because neither the clamp nor the OFFSET can be computed without
 * knowing how long the list is. Then the two block queries in parallel, either
 * of which may be skipped entirely.
 *
 * Worst case that is two round trips, against one unpaged fetch of the whole
 * Jira cache. It trades a little latency for a transfer that stops growing with
 * the backlog, which the old fetch did not.
 */
export async function getTicketPage({
  page,
  perPage = TICKETS_PER_PAGE,
  mine = null,
  status = null,
  hideStatuses = null,
}: TicketPageQuery): Promise<TicketPage> {
  const filter = mine ?? null;
  const selected = status ? statusKey(status) : null;
  // An EMPTY hide list is not the same as no hide list, and both are reachable:
  // Settings can hold nothing, which must hide nothing rather than everything.
  // Normalised to null so the `IS NULL` branch in the SQL handles it.
  const hidden = hideStatuses?.length ? hideStatuses.map(statusKey) : null;

  const statuses = await statusCounts(filter, hidden);

  // The chips describe the whole list; the pager describes the cut on screen.
  // Both are read off the one aggregate, so they cannot come to differ — and a
  // `?status=` naming something nobody is at totals zero rather than throwing.
  const bucket = selected ? statuses.find((entry) => entry.key === selected) : null;
  const holding = selected ? (bucket?.holding ?? 0) : sum(statuses, "holding");
  const issueTotal = selected ? (bucket?.issues ?? 0) : sum(statuses, "issues");

  const position = pagePosition(holding + issueTotal, page, perPage);
  const offset = (position.page - 1) * perPage;

  // Every claim sorts before every issue, so a page takes whatever is left of
  // the claims block and tops up from the issues block.
  const claimOffset = Math.min(offset, holding);
  const claimLimit = Math.max(0, Math.min(holding - offset, perPage));
  const issueOffset = Math.max(0, offset - holding);
  const issueLimit = perPage - claimLimit;

  const [claims, issues] = await Promise.all([
    claimsPage(claimLimit, claimOffset, filter, selected, hidden),
    issuesPage(issueLimit, issueOffset, filter, selected, hidden),
  ]);

  return { claims, issues, holdingTotal: holding, issueTotal, statuses, position };
}
