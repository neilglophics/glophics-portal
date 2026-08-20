/**
 * Message length, in one place.
 *
 * Imported by both the composer and the send route, so the number a user is
 * shown and the number the server enforces cannot drift. Change it here and
 * both follow.
 *
 * ── Why 2000 ──
 *
 * Generous for a coordination chat — roughly 300 words, several paragraphs —
 * while still being a message rather than a document. The database CHECK sits at
 * 8000 as a backstop, so this can be raised up to that without a migration.
 *
 * ── Why the composer does NOT use maxLength ──
 *
 * `maxLength` on a textarea silently truncates a paste. On this board somebody
 * will paste a stack trace or a Jira description, and losing the tail of it
 * without being told is worse than being stopped: they would send half a trace
 * believing it went whole. So over-typing is allowed, the counter turns red, and
 * Send is disabled until it is under — nothing is discarded quietly.
 */

/** What the composer allows and the server accepts. */
export const MESSAGE_MAX_LENGTH = 2000;

/**
 * Show the counter only once it is worth watching. A permanent "0 / 2000" is
 * noise on every short message, which is most of them.
 */
export const MESSAGE_COUNTER_THRESHOLD = Math.floor(MESSAGE_MAX_LENGTH * 0.8);

/** Counts what a person sees, not what JavaScript indexes.
 *
 *  `"👍".length` is 2 and `"é"` can be 1 or 2 depending on normalisation, so a
 *  naive `.length` tells somebody they have used two characters for one emoji.
 *  Intl.Segmenter counts grapheme clusters, which is what "characters" means to
 *  the person typing. */
export function messageLength(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of segmenter.segment(text)) n += 1;
    return n;
  }
  // Older runtimes: at least count astral pairs once rather than twice.
  return [...text].length;
}

export function isOverLimit(text: string): boolean {
  return messageLength(text) > MESSAGE_MAX_LENGTH;
}
