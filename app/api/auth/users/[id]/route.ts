import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { deleteAuthUser, updateAuthUser } from "@/lib/db/queries/auth";
import { notifyConfig } from "@/lib/revalidate";
import { publishToUser, socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Edit a login: username, display name, role, active flag, directory link.
 *
 * A role change or a deactivation drops that person's sessions inside the same
 * transaction, so an already-open tab loses the access it just lost rather than
 * keeping it until reload. That behaviour is documented and load-bearing.
 *
 * `session.revoked` is what makes it *visible*. Without it the dropped session
 * keeps rendering until that tab happens to make a request — the exact gap the
 * legacy app had, where the client only re-checked when its stream dropped.
 * Published unconditionally on any edit: working out whether a given change
 * revoked anything duplicates logic that already lives in updateAuthUser, and
 * being told to re-check when nothing changed costs one request.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const actor = await requireUser("manage-users");

  const { id } = await ctx.params;
  const userId = decodeURIComponent(id);
  const body = await readJson<Record<string, unknown>>(req);

  const result = await updateAuthUser(userId, body, actor.id);
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("login.changed", { userId }, { socketId: socketIdFrom(req) });
  await publishToUser(userId, "session.revoked", {});

  return Response.json({ ok: true, user: result.user });
});

export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  const actor = await requireUser("manage-users");

  const { id } = await ctx.params;
  const userId = decodeURIComponent(id);

  const result = await deleteAuthUser(userId, actor.id);
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  // Published before the account is gone from the client's point of view, so a
  // tab open as that person is returned to the sign-in screen immediately rather
  // than discovering it on its next request.
  await publishToUser(userId, "session.revoked", {});
  await notifyConfig("login.changed", { userId }, { socketId: socketIdFrom(req) });

  return Response.json({ ok: true });
});
