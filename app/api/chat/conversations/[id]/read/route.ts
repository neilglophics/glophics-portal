import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { markRead } from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToConversation, socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * Advances the viewer's read watermark.
 *
 * Read state is a watermark on the membership row, not a receipt per message —
 * O(members) rather than O(messages × members) for something that renders as one
 * tick (ADR-006). markRead uses GREATEST, so a second tab reporting an older
 * position cannot un-read what the first one saw.
 */
export const POST = withApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.read", user.id);

  const { id } = await ctx.params;
  const body = await readJson<{ lastReadMessageId?: number }>(req);

  const requested = Number(body.lastReadMessageId ?? 0);
  const lastReadMessageId = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;

  const result = await markRead(id, user.id, lastReadMessageId);

  // Told to the conversation so other members can render "read up to here".
  // Carries no message content — only a position.
  await publishToConversation(
    id,
    "read.changed",
    { conversationId: id, userId: user.id, lastReadMessageId: result.lastReadMessageId },
    { socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true, ...result });
});
