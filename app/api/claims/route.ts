import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { createClaim, type NewClaim } from "@/lib/db/queries/claims";
import { getSettings } from "@/lib/db/queries/board";
import { notifyOccupancy } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * Claim repositories on one environment.
 *
 * Replaces the whole-board `POST /api/state`. This touches only the claim it
 * creates, so two people claiming different environments at the same moment can
 * both succeed — which the legacy last-write-wins path could not guarantee.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("claim");

  const body = await readJson<Partial<NewClaim> & { socketId?: string }>(req);
  if (!body.serverId) throw new HttpError(400, "Which environment?");

  const settings = await getSettings();

  const result = await createClaim(
    {
      serverId: body.serverId,
      repos: Array.isArray(body.repos) ? body.repos : [],
      userIds: Array.isArray(body.userIds) ? body.userIds : [],
      jiraTicket: body.jiraTicket ?? null,
      summary: body.summary ?? null,
      note: body.note ?? null,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      jiraStatus: body.jiraStatus ?? null,
    },
    settings,
  );

  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  // After the commit, never inside it.
  await notifyOccupancy(
    "claim.created",
    { claimId: result.value.id, serverId: body.serverId, repos: body.repos ?? [] },
    { serverId: body.serverId, socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true, id: result.value.id });
});
