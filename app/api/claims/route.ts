import { revalidatePath } from "next/cache";
import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { createClaim, type NewClaim } from "@/lib/db/queries/claims";
import { getSettings } from "@/lib/db/queries/board";

export const runtime = "nodejs";

/**
 * Claim repositories on one environment.
 *
 * Replaces the whole-board `POST /api/state`. This touches only the claim it
 * creates, so two people claiming different environments at the same moment can
 * both succeed — which the legacy last-write-wins path could not guarantee.
 *
 * Phase 7 adds a `claim.created` publish on `private-board` here, after the
 * transaction commits. Until then the client revalidates its own paths.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("claim");

  const body = await readJson<Partial<NewClaim>>(req);
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

  // Every page that shows occupancy. Cheap, and it means a claim made here is
  // visible on the dashboard without a hard reload.
  for (const path of ["/dashboard", "/environments", "/tickets", "/my-tickets", "/in-use"]) {
    revalidatePath(path);
  }
  revalidatePath(`/environments/${body.serverId}`);

  return Response.json({ ok: true, id: result.value.id });
});
