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
 * many claims match is enough to work out which — so the count comes first, then
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
 */

import { sql } from "@/lib/db/client";
import { TICKETS_PER_PAGE, pagePosition } from "@/lib/shared/pagination";
import type { PagePosition } from "@/lib/shared/pagination-types";
import { toClaim, toJiraIssue, type ClaimRow, type JiraIssueRow } from "./board";
import type { Claim, JiraIssue } from "@/lib/types";

export interface TicketPage {
  /** Only the claims that fall on this page, in display order. */
  claims: Claim[];
  /** Only the cached issues that fall on this page, in display order. */
  issues: JiraIssue[];
  /** Every claim matching the query, not just this page: the sub-line under the
   *  page title reports on the whole list, not on the screenful. */
  holdingTotal: number;
  issueTotal: number;
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
 * One known narrowing: JS `.trim()` strips all Unicode whitespace, `btrim()`
 * strips spaces. A Jira display name with a leading tab would match in JS and
 * not here. The verify script would report it; no row in the board has one.
 */

/** Both totals in one round trip. */
async function counts(mine: string[] | null): Promise<{ holding: number; issues: number }> {
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int
         FROM claims c
        WHERE ${mine}::text[] IS NULL
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
              )
      ) AS holding,
      (SELECT count(*)::int
         FROM jira_issues j
        WHERE ${mine}::text[] IS NULL
           OR EXISTS (
                SELECT 1 FROM unnest(j.user_ids) AS u
                 WHERE lower(btrim(u)) = ANY(${mine}::text[])
                    OR lower(btrim(COALESCE(
                         (SELECT d.name FROM directory_users d WHERE d.id = u), u))) = ANY(${mine}::text[])
              )
           OR EXISTS (
                SELECT 1 FROM unnest(j.raw_assignees) AS r
                 WHERE lower(btrim(r)) = ANY(${mine}::text[])
              )
      ) AS issues
  `) as { holding: number; issues: number }[];

  return rows[0] ?? { holding: 0, issues: 0 };
}

/**
 * Claims, soonest to free first.
 *
 * `end_time ASC NULLS LAST` is what lib/shared/view-model.ts spells nullsLast():
 * a claim with no end time is not urgent, it is unknown, and belongs at the
 * bottom rather than the top. `claimed_at DESC` then reproduces the order the
 * unpaged getClaims() hands to a stable JS sort, and `id` closes the tie for
 * good so OFFSET has a total order to walk.
 */
async function claimsPage(limit: number, offset: number, mine: string[] | null): Promise<Claim[]> {
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
     WHERE ${mine}::text[] IS NULL
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
           )
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
): Promise<JiraIssue[]> {
  if (limit <= 0) return [];

  const rows = (await sql`
    SELECT j.key, j.server_id, j.account_name, j.branch, j.status, j.summary,
           j.start_time, j.end_time, j.repos, j.user_ids, j.raw_assignees,
           j.jira_created_at, j.jira_updated_at
      FROM jira_issues j
     WHERE ${mine}::text[] IS NULL
        OR EXISTS (
             SELECT 1 FROM unnest(j.user_ids) AS u
              WHERE lower(btrim(u)) = ANY(${mine}::text[])
                 OR lower(btrim(COALESCE(
                      (SELECT d.name FROM directory_users d WHERE d.id = u), u))) = ANY(${mine}::text[])
           )
        OR EXISTS (
             SELECT 1 FROM unnest(j.raw_assignees) AS r
              WHERE lower(btrim(r)) = ANY(${mine}::text[])
           )
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
}: TicketPageQuery): Promise<TicketPage> {
  const filter = mine ?? null;
  const { holding, issues: issueTotal } = await counts(filter);

  const position = pagePosition(holding + issueTotal, page, perPage);
  const offset = (position.page - 1) * perPage;

  // Every claim sorts before every issue, so a page takes whatever is left of
  // the claims block and tops up from the issues block.
  const claimOffset = Math.min(offset, holding);
  const claimLimit = Math.max(0, Math.min(holding - offset, perPage));
  const issueOffset = Math.max(0, offset - holding);
  const issueLimit = perPage - claimLimit;

  const [claims, issues] = await Promise.all([
    claimsPage(claimLimit, claimOffset, filter),
    issuesPage(issueLimit, issueOffset, filter),
  ]);

  return { claims, issues, holdingTotal: holding, issueTotal, position };
}
