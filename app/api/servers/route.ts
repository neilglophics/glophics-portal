import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { createServer, type ServerInput } from "@/lib/db/queries/config";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * A new environment. Its name is the "Branch" Jira matches on, and its account
 * decides which repository slots it carries.
 *
 * The legacy version nudged an immediate Jira sync here, because a ticket for
 * this exact account+branch may already be sitting in Jira waiting to claim it.
 * That nudge is now POST /api/jira/sync-now, which the client calls next.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("configure");

  const body = await readJson<Partial<ServerInput>>(req);
  const result = await createServer({
    name: String(body.name ?? ""),
    accountId: String(body.accountId ?? ""),
    repoUrls: body.repoUrls ?? {},
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("server.changed", { serverId: result.value.id }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true, id: result.value.id });
});
