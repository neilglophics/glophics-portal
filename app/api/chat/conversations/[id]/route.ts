import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { conversationDetail, renameGroup } from "@/lib/db/queries/chat";
import { publishGroupChange } from "@/lib/chat/publish";
import { requireWithinLimit } from "@/lib/rate-limit";
import { socketIdFrom } from "@/lib/realtime/server";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One conversation: its members, their roles, and the viewer's own standing.
 *
 * What the manage-group dialog refetches after `members.changed`. Scoped to the
 * caller by `conversationDetail`, which reads through the viewer's own list — so
 * there is no shape of this request that returns a conversation they are not in.
 */
export const GET = withApi(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  const conversation = await conversationDetail(id, user.id);
  return Response.json({ ok: true, conversation });
});

/**
 * Renames a group. Owner and admins only, enforced in `renameGroup`.
 *
 * PATCH because it changes one field of an existing thing, and — like every
 * mutation here — because it is not a GET: `SameSite=Lax` is the whole of this
 * app's CSRF protection, and a state-changing GET would quietly forfeit it.
 *
 * The rename writes a system message, so the fan-out is the shared one rather
 * than a bespoke publish. `revalidatePath` for the chat tree because the
 * conversation list is server-rendered and its title has just changed.
 */
export const PATCH = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.group.manage", user.id);

  const { id } = await ctx.params;
  const body = await readJson<{ title?: string }>(req);

  const result = await renameGroup(id, user.id, String(body.title ?? ""));

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: [result.systemMessage],
    socketId: socketIdFrom(req),
    // No avatar version: nothing happened to the photo, and sending null there
    // means "keep what you have" rather than "there isn't one".
    updated: { title: result.title, avatarVersion: null },
  });

  revalidatePath("/chat", "layout");

  return Response.json({ ok: true, title: result.title });
});
