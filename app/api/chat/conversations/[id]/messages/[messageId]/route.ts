import { requireUser, withApi } from "@/lib/auth/require";
import { deleteMessage } from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToConversation } from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; messageId: string }> };

/**
 * Deletes one of your own messages.
 *
 * A soft delete for the message and a hard one for its reactions — see
 * `deleteMessage`, where the reasoning for the asymmetry lives.
 *
 * The publish is not filtered by socket id. The acting tab has to be told too:
 * unlike a send, where the POST response carries the real row back, "deleted" is
 * a state the tab needs to render on a bubble that is already on screen, and it
 * gets there by the same event as everybody else's rather than by a second path
 * that could disagree with it.
 *
 * A repeat delete answers ok with `alreadyDeleted`, and publishes nothing — the
 * first one already told everybody.
 */
export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.message.delete", user.id);

  const { id, messageId } = await ctx.params;

  const numeric = Number(messageId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return Response.json({ ok: false, error: "No such message." }, { status: 404 });
  }

  const result = await deleteMessage(id, numeric, user.id);

  if (!result.alreadyDeleted) {
    await publishToConversation(id, "message.deleted", { id: numeric, conversationId: id });
  }

  return Response.json({ ok: true, id: numeric, alreadyDeleted: result.alreadyDeleted });
});
