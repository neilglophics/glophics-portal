import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { deleteAuthUser, updateAuthUser } from "@/lib/db/queries/auth";
import { revalidateConfig } from "@/lib/revalidate";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Edit a login: username, display name, role, active flag, directory link.
 *
 * A role change or a deactivation drops that person's sessions inside the same
 * transaction, so an already-open tab loses the access it just lost rather than
 * keeping it until reload. That behaviour is documented and load-bearing.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const actor = await requireUser("manage-users");

  const { id } = await ctx.params;
  const body = await readJson<Record<string, unknown>>(req);

  const result = await updateAuthUser(decodeURIComponent(id), body, actor.id);
  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  revalidateConfig();
  return Response.json({ ok: true, user: result.user });
});

export const DELETE = withApi(async (_req: Request, ctx: Ctx) => {
  const actor = await requireUser("manage-users");

  const { id } = await ctx.params;
  const result = await deleteAuthUser(decodeURIComponent(id), actor.id);

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  revalidateConfig();
  return Response.json({ ok: true });
});
