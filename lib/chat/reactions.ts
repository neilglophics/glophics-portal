/**
 * The reaction vocabulary, and the local half of the toggle.
 *
 * ── One list, enforced twice ──
 *
 * `REACTION_EMOJI` is read by the picker in the browser AND by the route handler
 * that writes the row — the same shape as `AUTH_ROLES` in lib/shared/roles.ts,
 * and for the same reason: what the UI offers and what the server accepts cannot
 * be allowed to drift. **Showing six emoji is courtesy; the server is the
 * boundary.** Never add an emoji to the picker without adding it here.
 *
 * It is deliberately NOT a database CHECK. See the note in
 * lib/db/migrations/0004_chat_reactions_and_groups.sql — the column carries a
 * length bound as a backstop and nothing more, so adding 🤔 later is a one-line
 * change rather than a migration.
 *
 * ── Why a closed set at all ──
 *
 * A free-text emoji field is a free-text field, which on a work board is a way
 * to write something in a place nobody moderates and everybody sees. Six covers
 * what a coordination chat actually needs.
 */

/** The picker's contents, in the order it renders them. */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/**
 * A label for each, because an emoji has no accessible name.
 *
 * A screen reader announcing "grinning face with smiling eyes button" for a
 * bare 👍 is not useful; "React with thumbs up" is.
 */
export const REACTION_LABEL: Record<ReactionEmoji, string> = {
  "👍": "Thumbs up",
  "❤️": "Heart",
  "😂": "Laugh",
  "😮": "Surprised",
  "😢": "Sad",
  "🎉": "Celebrate",
};

/**
 * Membership test used by the route handler.
 *
 * Compared against the literal list rather than by pattern-matching for emoji
 * properties: "is this one of ours" is a question with a finite answer, and a
 * regex over Unicode emoji classes would quietly accept a few thousand things
 * nobody chose.
 */
export function isAllowedReaction(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJI as readonly string[]).includes(value);
}

// ---------- shapes ----------

/**
 * The reactions on one message, one entry per emoji that has at least one
 * reactor.
 *
 * `users` and not just a count, so hovering can say who — and so `mine` never
 * has to be computed on the server per viewer. The same payload is correct for
 * everybody, which is what lets a single `reaction.changed` event go to the whole
 * conversation rather than one tailored event per member.
 */
export interface ReactionGroup {
  emoji: string;
  users: { id: string; displayName: string }[];
}

/** Did the viewer react with this emoji? */
export function reactedByViewer(group: ReactionGroup, viewerId: string): boolean {
  return group.users.some((u) => u.id === viewerId);
}

/**
 * The optimistic half of a toggle: what the row should look like the instant a
 * tap lands, before the server has answered.
 *
 * Pure, and therefore tested (tests/chat-reactions.test.ts). Three properties it
 * has to hold, all of which are things the UI gets visibly wrong without them:
 *
 *   1. IT IS ITS OWN INVERSE. Tapping twice returns the original, so a
 *      double-tap does not leave a phantom reaction on screen.
 *   2. AN EMPTIED GROUP DISAPPEARS. A "0" pill is not a state; the last person
 *      removing their reaction removes the pill.
 *   3. ORDER IS STABLE. A group keeps its position while its count changes,
 *      because a row of pills that reshuffles under a cursor is a row you cannot
 *      click twice in a row. A brand-new emoji appends.
 */
export function applyReactionToggle(
  groups: readonly ReactionGroup[],
  emoji: string,
  viewer: { id: string; displayName: string },
): ReactionGroup[] {
  const existing = groups.find((g) => g.emoji === emoji);

  if (!existing) {
    return [...groups, { emoji, users: [viewer] }];
  }

  const had = existing.users.some((u) => u.id === viewer.id);
  const users = had
    ? existing.users.filter((u) => u.id !== viewer.id)
    : [...existing.users, viewer];

  // The pill goes when it empties, rather than rendering a zero.
  if (!users.length) return groups.filter((g) => g.emoji !== emoji);

  return groups.map((g) => (g.emoji === emoji ? { emoji, users } : g));
}

/**
 * Folds a server-authoritative group for ONE emoji into a message's row.
 *
 * This is what `reaction.changed` carries: the complete membership of the emoji
 * that changed, never a delta. A delta ("+1 from Sem") is not idempotent — a
 * duplicate event, or one that arrives after the tab already applied its own
 * optimistic toggle, would count twice. A whole group is order-independent and
 * safe to apply as many times as it arrives.
 *
 * An empty `users` means the last reactor removed theirs, so the group is
 * dropped rather than stored as an empty one.
 */
export function mergeReactionGroup(
  groups: readonly ReactionGroup[],
  incoming: ReactionGroup,
): ReactionGroup[] {
  const known = groups.some((g) => g.emoji === incoming.emoji);

  if (!incoming.users.length) return groups.filter((g) => g.emoji !== incoming.emoji);
  if (!known) return [...groups, incoming];

  return groups.map((g) => (g.emoji === incoming.emoji ? incoming : g));
}

/**
 * "Sem, Jerome and 3 others reacted 👍" — the tooltip.
 *
 * Names up to three and counts the rest. A tooltip listing eleven names is a
 * tooltip taller than the message it describes.
 */
export function reactionTooltip(group: ReactionGroup, viewerId: string): string {
  // "You" first when present, by partitioning rather than by sorting: a
  // comparator that only knows about one element is not a total order, and
  // Array.sort with one of those is free to reorder everything else.
  const mine = group.users.filter((u) => u.id === viewerId).map(() => "You");
  const others = group.users.filter((u) => u.id !== viewerId).map((u) => u.displayName);
  const names = [...mine, ...others];

  if (!names.length) return "";

  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;

  if (rest > 0) {
    return `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
  }
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
