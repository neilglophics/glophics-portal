import type { MessageRow } from "@/lib/db/queries/chat";

/**
 * Folds incoming messages into a thread the client already has.
 *
 * This is the whole reason the message list can own its state safely, so it is
 * kept out of the component and tested. Three properties it must hold:
 *
 *   1. IT ONLY EVER ADDS OR UPDATES. Nothing on screen disappears because a
 *      `router.refresh()` happened to race a send. That is what makes it safe to
 *      merge the server's copy in on every refresh rather than ignoring it.
 *
 *   2. IT DE-DUPLICATES BY ID. The same message can arrive twice — once from a
 *      catch-up fetch and once from a live event — and must render once.
 *
 *   3. INCOMING WINS. A later copy of the same id is either identical or newer
 *      (an edit, a deletion), so it replaces rather than being discarded.
 *
 * Ordering is ascending by id: oldest at the top, which is how a thread reads.
 * Ids are a monotonic bigserial, so that is also true chronological order — no
 * timestamp comparison, and no clock skew between whoever sent what.
 */
export function mergeMessages(prev: MessageRow[], incoming: MessageRow[]): MessageRow[] {
  if (!incoming.length) return prev;

  const byId = new Map<number, MessageRow>();
  for (const m of prev) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Drops optimistic entries the server has now confirmed.
 *
 * The sender is excluded from its own Pusher fan-out, so a sent message arrives
 * back through the POST response rather than as an event. Matching on
 * `clientMsgId` is what turns the grey pending bubble into the real one instead
 * of leaving both on screen.
 */
export function dropConfirmedPending<T extends { clientMsgId: string }>(
  pending: T[],
  confirmed: readonly { clientMsgId: string }[],
): T[] {
  if (!pending.length) return pending;
  const seen = new Set(confirmed.map((m) => m.clientMsgId));
  return pending.filter((p) => !seen.has(p.clientMsgId));
}
