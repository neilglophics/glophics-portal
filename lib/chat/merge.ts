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

/**
 * What a deleted message's quote says. One constant, because two places render it:
 * `replyPreviewFrom` on the server for a fresh page, and `applyMessageDeletion`
 * here for a thread that is already on screen. If they disagreed, a reply would
 * change its wording on reload.
 */
export const DELETED_MESSAGE_PREVIEW = "Message deleted";

/**
 * Folds a deletion into a thread the client already has.
 *
 * ── Why this touches more than one message ──
 *
 * Deleting a message changes TWO things on screen, and the second one is easy to
 * miss because it is not the message you deleted:
 *
 *   1. the message itself becomes "Message deleted" and loses its body, its
 *      reactions and its files;
 *   2. **every reply quoting it** must stop quoting it.
 *
 * (2) was the bug. `message.deleted` patched only (1), so a reply carried on
 * displaying the withdrawn text — and a thumbnail of the withdrawn image — until
 * somebody reloaded. The server has always been right here (`replyPreviewFrom`
 * checks the parent's `deleted_at`), which is what made it look like a rendering
 * quirk rather than a leak: the content was unreachable through the API and still
 * on screen.
 *
 * Pure, so both paths use it: the acting tab's optimistic update and the
 * `message.deleted` event everybody else receives. One function, so the deleter
 * and the readers cannot end up seeing different things.
 *
 * The reply keeps its `replyTo` rather than dropping it. Somebody DID reply to
 * something, the parent row still occupies its slot, and the quote stays tappable
 * — it just lands on "Message deleted", which is the honest outcome.
 */
export function applyMessageDeletion(
  messages: readonly MessageRow[],
  deletedId: number,
  deletedAt: string,
): MessageRow[] {
  return messages.map((m) => {
    if (m.id === deletedId) {
      return {
        ...m,
        body: "",
        // Preserved if already set, so a duplicate event does not keep moving the
        // timestamp of something already deleted.
        deletedAt: m.deletedAt ?? deletedAt,
        reactions: [],
        attachments: [],
      };
    }

    if (m.replyTo && m.replyTo.id === deletedId && !m.replyTo.deleted) {
      return {
        ...m,
        replyTo: {
          ...m.replyTo,
          preview: DELETED_MESSAGE_PREVIEW,
          deleted: true,
          // The image is gone with the message. Left in place, this is the actual
          // leak: a thumbnail whose bytes the download route now refuses, so it
          // would render as a broken image at best.
          thumbnailAttachmentId: null,
          attachmentCount: 0,
        },
      };
    }

    return m;
  });
}
