import { readJson, requireUser, withApi } from "@/lib/auth/require";
import {
  deleteDirectoryPerson,
  updateDirectoryPerson,
  type DirectoryInput,
} from "@/lib/db/queries/config";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withApi(async (req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const body = await readJson<Partial<DirectoryInput>>(req);

  const result = await updateDirectoryPerson(decodeURIComponent(id), {
    name: String(body.name ?? ""),
    jobRole: body.jobRole ? String(body.jobRole) : "",
    jiraNames: body.jiraNames,
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("directory.changed", { personId: decodeURIComponent(id) }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true });
});

export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  await requireUser("configure");

  const { id } = await ctx.params;
  const result = await deleteDirectoryPerson(decodeURIComponent(id));

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("directory.changed", { personId: decodeURIComponent(id) }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true });
});
