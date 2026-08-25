/**
 * Where a conversation sits in the list.
 *
 * ── Why this is a module and not four lines inside the component ──
 *
 * The rule is "most recent activity first", which sounds like a one-line sort and
 * is not, because there are two sources of truth in play: the server's
 * `last_message_at`, correct when the page was rendered, and the live activity
 * collected from `unread.changed` since. Getting the merge wrong produces bugs
 * that are invisible in a screenshot and obvious in use — a conversation that
 * jumps back down a moment after rising, or two that swap places on an unrelated
 * render.
 *
 * Pure, so it is tested (tests/chat-ordering.test.ts). Two previous bugs in this
 * codebase were client wiring that no test could see; this is the same shape of
 * logic, so it goes somewhere a test can reach it.
 */

/** The server's row, reduced to what ordering cares about. */
export interface OrderableConversation {
  id: string;
  lastMessageAt: string | null;
  createdAt: string;
}

/** What has arrived live since the server rendered. */
export interface LiveActivity {
  lastMessageAt: string;
  /** Local arrival order, for breaking timestamp ties. */
  seq: number;
}

/**
 * The timestamp a conversation should sort on, and its tiebreak.
 *
 * ── It takes the LATER of the two, never blindly the live one ──
 *
 * A `router.refresh()` can land after an event, so the server's row can be the
 * newer of the pair. Taking the live value unconditionally would walk a
 * conversation *backwards* in that case — a message arrives, the list updates
 * correctly, and then a refresh appears to undo it.
 *
 * A conversation that has never had a message falls back to when it was created,
 * so a brand-new empty conversation appears at the top where somebody who just
 * made it will look for it, rather than at the bottom with the null timestamps.
 */
export function effectiveActivity(
  conversation: OrderableConversation,
  live: LiveActivity | undefined,
): { at: string; seq: number } {
  const server = conversation.lastMessageAt ?? conversation.createdAt;
  if (!live) return { at: server, seq: 0 };

  return live.lastMessageAt > server
    ? { at: live.lastMessageAt, seq: live.seq }
    : { at: server, seq: live.seq };
}

/**
 * Sorts conversations newest-first, folding live activity over the server's rows.
 *
 * ── The sort is TOTAL, and that is not fussiness ──
 *
 * Timestamp, then arrival order, then id. Two messages can share a millisecond
 * — two people sending at once, or a system message written in the same
 * transaction as another — and a comparator that returns 0 for them leaves their
 * relative order to the engine's sort stability and the order the objects happened
 * to be in. The visible symptom is the top two rows swapping places on renders
 * that have nothing to do with either of them.
 *
 * Returns a new array; the input is not mutated, because it is React props.
 */
export function orderConversations<T extends OrderableConversation>(
  conversations: readonly T[],
  activity: Readonly<Record<string, LiveActivity>>,
): T[] {
  return [...conversations].sort((a, b) => {
    const left = effectiveActivity(a, activity[a.id]);
    const right = effectiveActivity(b, activity[b.id]);

    if (left.at !== right.at) return left.at > right.at ? -1 : 1;
    if (left.seq !== right.seq) return right.seq - left.seq;
    // Last resort, so the order is deterministic even for two conversations that
    // agree on everything else.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Whether the live copy is the one to display.
 *
 * The preview and the timestamp have to make the same choice as the sort, or a row
 * moves to the top while still showing the previous message underneath it. Shared
 * rather than repeated for exactly that reason.
 */
export function preferLive(
  conversation: OrderableConversation,
  live: LiveActivity | undefined,
): boolean {
  if (!live) return false;
  return !conversation.lastMessageAt || live.lastMessageAt > conversation.lastMessageAt;
}
