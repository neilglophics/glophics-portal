/**
 * Who has seen how far — the little faces down the right-hand edge of a thread.
 *
 * ── Why a watermark becomes a position, not a badge ──
 *
 * Read state is stored as one number per member: the id of the newest message
 * they have read (ADR-006). That is deliberately not a receipt per message —
 * O(members) instead of O(messages × members) — and it is exactly what Messenger
 * renders: each person's avatar appears **once**, under the last message they got
 * to. The column of faces is a waterline showing how far each person has caught
 * up.
 *
 * So this turns `{ userId: lastReadId }` into `{ messageId: userId[] }`, which is
 * what a message list can render directly.
 *
 * ── The rule, and the two cases that make it non-trivial ──
 *
 * A person's face goes on the newest LOADED message whose id is at or below their
 * watermark. Two consequences worth stating:
 *
 *   - **Their watermark is usually not a message id in this page.** They read up
 *     to message 900; the page holds 880, 895 and 910. Their face goes on 895 —
 *     the newest thing they have seen that is on screen — not nowhere.
 *   - **A watermark older than the whole page shows nothing.** They are behind the
 *     top of the loaded window, so there is no rendered message to attach them to.
 *     Silence is right; guessing would put them on the oldest message on screen
 *     and claim they had read less than they have.
 *
 * Pure, and therefore tested. This is UI logic that no query can be wrong about
 * and no integration test would reach.
 */

export interface ReadReceipt {
  /** Members whose watermark lands on this message, in a stable order. */
  userIds: string[];
}

/**
 * Places each member's avatar on the newest message they have read.
 *
 * `viewerId` is excluded: your own face telling you that you have read your own
 * conversation is noise, and Messenger does not show it either.
 *
 * `messages` must be ascending by id — which is how the thread holds them, and
 * how `mergeMessages` guarantees they arrive.
 */
export function readReceipts(
  messages: readonly { id: number }[],
  readUpTo: Readonly<Record<string, number>>,
  viewerId: string,
): Map<number, string[]> {
  const byMessage = new Map<number, string[]>();
  if (!messages.length) return byMessage;

  for (const [userId, watermark] of Object.entries(readUpTo)) {
    if (userId === viewerId) continue;
    if (!watermark) continue;

    // The newest message at or below their watermark. Walked from the end
    // because the answer is almost always the last message or very near it —
    // most people are caught up.
    let landed: number | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.id <= watermark) {
        landed = messages[i]!.id;
        break;
      }
    }

    // Behind the top of the loaded window: nothing on screen to attach them to.
    if (landed === null) continue;

    const existing = byMessage.get(landed);
    if (existing) existing.push(userId);
    else byMessage.set(landed, [userId]);
  }

  // Sorted per message so the row of faces does not reshuffle between renders —
  // Object.entries order is insertion order on the watermark map, which changes
  // as `read.changed` events arrive.
  for (const userIds of byMessage.values()) userIds.sort();

  return byMessage;
}

/**
 * "Seen by Alex and Jamie" — the tooltip on a row of faces.
 *
 * Names up to three and counts the rest, same shape as the reaction tooltip: a
 * tooltip listing eleven names is taller than the message it describes.
 */
export function seenByLabel(names: readonly string[]): string {
  if (!names.length) return "";

  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;

  if (rest > 0) return `Seen by ${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
  if (shown.length === 1) return `Seen by ${shown[0]}`;
  return `Seen by ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
