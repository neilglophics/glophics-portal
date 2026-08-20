import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { setPassword } from "@/lib/db/queries/auth";
import { publishToUser } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * A super admin resetting somebody else's password. No current password is asked
 * for — that is what makes it a reset rather than a change.
 *
 * Every session that person had is dropped, so they sign in again with the new
 * one. Nothing is revalidated here: no page renders a password.
 */
export const POST = withApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("manage-users");

  const { id } = await ctx.params;
  const userId = decodeURIComponent(id);
  const body = await readJson<{ password?: string }>(req);

  const result = await setPassword(userId, body.password);
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  // Their sessions were dropped by setPassword. Tell any open tab so it
  // returns to the sign-in screen now rather than on its next request.
  await publishToUser(userId, "session.revoked", {});

  return Response.json({ ok: true });
});
