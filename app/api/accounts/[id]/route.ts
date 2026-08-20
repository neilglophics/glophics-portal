import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { deleteAccount, updateAccount, type AccountInput } from "@/lib/db/queries/config";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Editing an account ripples outward — see updateAccount(). Repos added here
 * appear unconfigured on every environment under the account; repos dropped here
 * take their URLs, notes and claims with them.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const body = await readJson<Partial<AccountInput>>(req);

  const result = await updateAccount(decodeURIComponent(id), {
    displayName: String(body.displayName ?? ""),
    repositories: Array.isArray(body.repositories) ? body.repositories.map(String) : [],
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("account.changed", { accountId: decodeURIComponent(id) }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true });
});

export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const result = await deleteAccount(decodeURIComponent(id));

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("account.changed", { accountId: decodeURIComponent(id) }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true });
});
