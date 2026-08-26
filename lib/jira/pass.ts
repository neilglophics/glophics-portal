/**
 * How much of Jira one sync pass asks for.
 *
 * Split out of ./sync.ts and kept pure — no database, no network, no clock
 * except the one handed in — for the same reason ./matching.ts is: this is a
 * rule, and a rule that can only be exercised by running a real sync against a
 * real Jira is a rule nobody checks. tests/jira-pass.test.ts is the check.
 *
 * ── Why most passes are incremental ──
 *
 * The board polls once a minute while anybody has a tab open, and it used to
 * re-read the entire 30-day window every time: several hundred issues fetched,
 * parsed and re-inserted to discover that two of them had moved. That was
 * affordable only because the search was ALSO cut down to a handful of statuses
 * — and cutting the search is exactly what had to stop for My tickets to be
 * able to show somebody everything assigned to them (ADR-014).
 *
 * So the window shrank instead of the status list. A delta pass asks
 * `updated >= -Nm`, where N is the gap since the last successful pass plus an
 * overlap, and ./sync.ts reconciles what comes back ticket by ticket rather
 * than rebuilding the cache. A minute of Jira activity is a handful of tickets,
 * so the ordinary pass now costs a fraction of what it did while carrying
 * strictly more of Jira than it used to.
 *
 * ── When it still asks for everything ──
 *
 * A delta pass can only ever add to and update what is cached; it has no way to
 * notice a ticket DELETED in Jira, because a deleted ticket appears in no
 * search. Only a rebuild drops it. So the daily cron and the Refresh buttons
 * ask for `full`, and a first sync — or one after a gap longer than the window
 * itself — is full because there is nothing to be incremental against.
 *
 * A deleted ticket therefore lingers for at most a day, against a poll costing
 * a fraction of what it did. Both halves of that trade are deliberate, and
 * docs/05-DECISIONS.md ADR-015 records them.
 */

/** How far back a FULL pass looks. A delta pass looks back to the last one. */
export const SYNC_WINDOW_DAYS = 30;
export const SYNC_WINDOW = `updated >= -${SYNC_WINDOW_DAYS}d`;
export const FULL_WINDOW_MINUTES = SYNC_WINDOW_DAYS * 24 * 60;

/**
 * How much further back than "since the last sync" a delta pass reaches.
 *
 * Jira computes `-Nm` against its OWN clock, which is why the window is
 * relative rather than an absolute timestamp — there is no timezone to get
 * wrong, and no format to disagree about. What is left is clock skew between
 * that machine and this one, plus the seconds a pass itself takes. Five minutes
 * of overlap costs a few re-read tickets and closes the only hole a delta pass
 * can have: an update landing in the gap between two passes.
 */
export const DELTA_OVERLAP_MINUTES = 5;

/**
 * `full` re-reads the whole window and rebuilds the derived cache from it.
 * `delta` asks only for what changed since the last successful pass and
 * reconciles ticket by ticket.
 */
export type SyncMode = "full" | "delta";

export interface Pass {
  mode: SyncMode;
  /** The JQL window clause — what buildJql() wraps. */
  window: string;
}

const FULL: Pass = { mode: "full", window: SYNC_WINDOW };

export function planPass(
  requested: SyncMode | "auto",
  lastSyncAt: string | Date | null,
  now: number = Date.now(),
): Pass {
  if (requested === "full" || !lastSyncAt) return FULL;

  const since = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(since)) return FULL;

  const minutes = Math.ceil((now - since) / 60_000) + DELTA_OVERLAP_MINUTES;

  // A clock that has gone backwards, or a gap wider than the window a full pass
  // would read anyway: in both cases the incremental question is meaningless,
  // and the honest answer is to read the window.
  if (minutes <= 0 || minutes >= FULL_WINDOW_MINUTES) return FULL;

  return { mode: "delta", window: `updated >= -${minutes}m` };
}

/**
 * ── Why there is no status filter here any more ──
 *
 * This query used to cut `ignoredStatuses` out of the search, so a ticket at
 * OPEN or DONE never entered the cache at all. That made My tickets
 * structurally unable to answer "everything assigned to me": a person's own
 * closed and not-yet-started work was not merely hidden, it was never fetched,
 * and no filter on the page could bring it back.
 *
 * The cut moved to where it belongs — the board reads. That list now means
 * "hidden from Active tickets" and is applied by lib/db/queries/tickets.ts.
 * See docs/05-DECISIONS.md ADR-014.
 */
export function buildJql(window: string, heldKeys: readonly string[]): string {
  // Rule 2 of the sync: held keys by name, whatever their status and whatever
  // the window. It is also what makes a broken pass detectable — see
  // assertJiraAnswered() in ./sync.ts.
  const where = heldKeys.length ? `(${window}) OR key IN (${heldKeys.join(", ")})` : window;
  return `${where} ORDER BY updated DESC`;
}
