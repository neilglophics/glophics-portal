import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { createAuthUser, listAuthUsers } from "@/lib/db/queries/auth";
import { AUTH_ROLES } from "@/lib/shared/roles";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/** Everyone who can sign in. Never carries a salt or a hash — only publicUser
 *  shapes leave the server. */
export const GET = withApi(async () => {
  await requireUser("manage-users");
  return Response.json({ ok: true, users: await listAuthUsers(), roles: AUTH_ROLES });
});

/** Give somebody a login, optionally linked to their directory entry. */
export const POST = withApi(async (req: Request) => {
  await requireUser("manage-users");

  const body = await readJson<Record<string, unknown>>(req);
  const result = await createAuthUser(body);

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("login.changed", { userId: result.user?.id ?? null }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true, user: result.user });
});
