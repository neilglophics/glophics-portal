import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { addGroupMembers, addableUsers } from "@/lib/db/queries/chat";
import { publishGroupChange } from "@/lib/chat/publish";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToUser, socketIdFrom } from "@/lib/realtime/server";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Who could still be added.
 *
 * Computed in SQL against the current membership rather than by filtering the
 * whole-team list in the dialog — a client-side filter is wrong for as long as the
 * two requests are apart, and "add" is exactly where that shows up as a
 * confusing 409.
 */
export const GET = withApi(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  const people = await addableUsers(id, user.id);
  return Response.json({ ok: true, people });
});

/**
 * Adds people to a group. Owner and admins, enforced in `addGroupMembers`.
 *
 * One system message per person, so the history answers "when did Jamie get
 * access to this" rather than "somebody added some people once".
 *
 * The people just added get `conversation.added` on their own channels — they
 * were not on the conversation channel a moment ago, so nothing published there
 * would have reached them.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.group.manage", user.id);

  const { id } = await ctx.params;
  const body = await readJson<{ userIds?: string[] }>(req);

  const result = await addGroupMembers(
    id,
    user.id,
    Array.isArray(body.userIds) ? body.userIds.map(String) : [],
  );

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: result.systemMessages,
    socketId: socketIdFrom(req),
  });

  for (const memberId of result.added) {
    await publishToUser(memberId, "conversation.added", { conversationId: id });
  }

  revalidatePath("/chat", "layout");

  return Response.json({ ok: true, added: result.added });
});
