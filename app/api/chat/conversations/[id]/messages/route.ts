import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { attachmentSummary } from "@/lib/chat/attachments";
import { plainText } from "@/lib/chat/mentions";
import {
  conversationUnread,
  listMessages,
  notificationTargets,
  sendMessage,
  totalUnread,
} from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import {
  conversationChannel,
  publishBatch,
  publishToConversation,
  socketIdFrom,
  userChannel,
} from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A page of messages.
 *
 * `?before=<id>` pages backwards through history. `?after=<id>` is the catch-up
 * direction, used on reconnect: Pusher does not replay, so a tab that was offline
 * asks for everything newer than the last id it rendered. Because ids are a
 * monotonic bigserial, `id > cursor` is exact — no timestamp comparison, no clock
 * skew, no overlap window.
 *
 * Membership is checked inside listMessages, not here, so it cannot be forgotten
 * by a second caller.
 */
export const GET = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit");

  const numeric = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };

  const result = await listMessages(id, user.id, {
    ...(numeric(before) !== undefined ? { before: numeric(before)! } : {}),
    ...(numeric(after) !== undefined ? { after: numeric(after)! } : {}),
    ...(numeric(limit) !== undefined ? { limit: numeric(limit)! } : {}),
  });

  return Response.json({ ok: true, ...result });
});

/**
 * Sends a message.
 *
 * Publishes AFTER the transaction commits. If it rolled back after Pusher had
 * been told, every member would render a message the database does not have.
 *
 * A duplicate `clientMsgId` is not republished: the first send already fanned it
 * out, and a retry echoing it again would show the message twice for everyone
 * except the sender, who de-duplicates on that id.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.send", user.id);

  const { id } = await ctx.params;
  const body = await readJson<{
    clientMsgId?: string;
    body?: string;
    replyToId?: number;
    attachmentIds?: string[];
  }>(req);

  const result = await sendMessage(id, user.id, {
    clientMsgId: String(body.clientMsgId ?? ""),
    body: String(body.body ?? ""),
    // The parent is verified against THIS conversation inside sendMessage — an id
    // from a request body must not be able to quote a message from a thread the
    // sender is not in.
    replyToId: typeof body.replyToId === "number" ? body.replyToId : null,
    // Claimed inside the send transaction, and only if they were staged by this
    // person for this conversation and not already sent. See claimAttachments.
    attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
  });

  if (result.created) {
    const socketId = socketIdFrom(req);

    await publishToConversation(id, "message.new", result.message, { socketId });

    // One batched call rather than one per recipient: a ten-person group would
    // otherwise multiply every message by ten separate API round trips.
    //
    // ── This goes to EVERY member now, muted ones and the sender included ──
    //
    // It used to skip both, which saved messages and broke two things: a muted
    // conversation never rose to the top of its members' lists, and the sender's
    // *other* tabs never reordered either. Both are ordering, and ordering is not
    // an interruption — so the event is delivered to everyone and each client
    // decides what to do with it. See notificationTargets.
    const targets = await notificationTargets(id, user.id);
    const mentioned = new Set(result.mentionIds);

    // Not just the body: an attachment-only message has none, and a toast saying
    // nothing is a toast that looks broken. `plainText` first, so a mention shows
    // as "@Alex" rather than as its raw `@[Alex](uuid)` token. The same helpers the
    // conversation list and the reply quote use, so all three describe a message
    // identically.
    const preview = attachmentSummary(
      plainText(result.message.body),
      result.message.attachments,
    ).slice(0, 140);

    if (targets.recipients.length) {
      const items = await Promise.all(
        targets.recipients.map(async (member) => ({
          channel: userChannel(member.userId),
          name: "unread.changed",
          data: {
            conversationId: id,
            // The title as THIS recipient sees it: a group's own name, or — for a
            // DM — the person who just wrote to them.
            conversationTitle:
              targets.kind === "group"
                ? (targets.title ?? "Group")
                : (result.message.senderName ?? "Someone"),
            senderName: result.message.senderName,
            preview,
            lastMessageAt: result.message.createdAt,
            muted: member.muted,
            ownMessage: member.isSender,
            mentioned: mentioned.has(member.userId),
            // The sender has already read what they just wrote — sendMessage
            // advances their own watermark — so this is 0 for them without a
            // special case.
            unreadCount: await conversationUnread(id, member.userId),
            totalUnread: await totalUnread(member.userId),
          },
        })),
      );
      await publishBatch(items);
    }
  }

  return Response.json({
    ok: true,
    message: result.message,
    created: result.created,
    channel: conversationChannel(id),
  });
});
