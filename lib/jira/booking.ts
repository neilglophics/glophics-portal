/**
 * Jira's dates turned into the instants a claim is stored with.
 *
 * Pure, and split out of ./sync.ts for the reason ./pass.ts was: the rule below
 * is only reachable through a ticket somebody mistyped in Jira, which is not a
 * thing you can arrange on demand to test. tests/jira-booking.test.ts is the
 * check.
 *
 * ── Why the times are 09:00 and 18:00 ──
 *
 * Jira gives DATES, not instants. The legacy app pinned them to 09:00 and 18:00
 * local, which is what "a day's booking" meant on this board, and the port kept
 * it. Local, deliberately: the board is read by one team in one timezone, and
 * 09:00 means the start of their day.
 */

export const startInstant = (date: string | null) =>
  date ? new Date(`${date}T09:00`).toISOString() : null;

export const endInstant = (date: string | null) =>
  date ? new Date(`${date}T18:00`).toISOString() : null;

export interface Booking {
  startTime: string | null;
  endTime: string | null;
}

/**
 * The window a ticket books, with contradictory dates made storable.
 *
 * ── Why this function exists ──
 *
 * `claims_time_order` requires `end_time > start_time` unless one is null, and
 * a claim that breaks it takes down the WHOLE sync: applySync() writes in one
 * transaction, so a single ticket with its due date before its start date rolls
 * back every other ticket in the pass. That is what happened to GLOP-1533 —
 * start 2026-08-26, due 2026-08-18 — and the board simply stopped updating,
 * with `new row for relation "claims" violates check constraint` as the only
 * sign. One person mistyping a date must not be able to stop the board.
 *
 * ── The two cases, which are not the same case ──
 *
 * They differ in WHOSE value is wrong, and the rule is the same both times:
 * never let a value we invented destroy one Jira actually gave us.
 *
 *   1. Both dates came from Jira and disagree. We know the ticket is being
 *      worked — it is at an occupying status — so the start stands and the end
 *      goes. "Held, and we do not know when it frees" is the honest reading of
 *      a contradiction, and it is a state the board already renders: an end
 *      time of null sorts last under `NULLS LAST`, because not-urgent and
 *      unknown are the same row (lib/db/queries/tickets.ts).
 *
 *   2. Only the start was invented. A claim with no start date "started now"
 *      (see the caller), and `now` collides with a real due date whenever that
 *      date is in the past — an ordinary overdue ticket. Here it is OUR value
 *      that is wrong, so it is ours that goes: the due date survives and the
 *      board can still say the ticket is overdue, which is true and useful.
 *
 * Nothing is swapped, inferred or nudged. Jira matching is exact and never
 * fuzzy (invariant 6), and guessing which of two dates the author meant would
 * be exactly that.
 */
export function bookingWindow(
  startDate: string | null,
  dueDate: string | null,
  /**
   * What a missing start date means to this caller. A claim is holding
   * something as of this pass, so it started `now`; a ticket that holds nothing
   * has no start at all, and passes null.
   */
  fallbackStart: string | null = null,
): Booking {
  const fromJira = startInstant(startDate);
  const endTime = endInstant(dueDate);

  // Case 1 — Jira's own two dates contradict each other.
  if (fromJira && endTime && endTime <= fromJira) {
    return { startTime: fromJira, endTime: null };
  }

  const startTime = fromJira ?? fallbackStart;

  // Case 2 — only the fallback collides, so the fallback is what gives way.
  if (startTime && endTime && endTime <= startTime) {
    return { startTime: null, endTime };
  }

  return { startTime, endTime };
}

/** Did bookingWindow() have to drop one of the two? Only for logging — the
 *  board renders the result either way, and this is how somebody finds out
 *  which ticket needs its dates fixed in Jira. */
export function bookingIsContradictory(startDate: string | null, dueDate: string | null): boolean {
  const start = startInstant(startDate);
  const end = endInstant(dueDate);
  return !!start && !!end && end <= start;
}
