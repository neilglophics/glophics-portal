import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { deleteServer, updateServer, type ServerInput } from "@/lib/db/queries/config";
import { revalidateConfig } from "@/lib/revalidate";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Renaming an environment changes which Jira tickets match it, so claims
 * recorded under the old name are rewritten — see updateServer(). An untouched
 * repo URL keeps the health last measured for it; only a changed one resets.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const body = await readJson<Partial<ServerInput>>(req);

  const result = await updateServer(decodeURIComponent(id), {
    name: String(body.name ?? ""),
    accountId: String(body.accountId ?? ""),
    repoUrls: body.repoUrls ?? {},
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  revalidateConfig();
  return Response.json({ ok: true });
});

export const DELETE = withApi(async (_req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const result = await deleteServer(decodeURIComponent(id));

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  revalidateConfig();
  return Response.json({ ok: true });
});
