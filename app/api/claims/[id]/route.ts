import { requireUser, withApi } from "@/lib/auth/require";
import { sql } from "@/lib/db/client";
import { releaseClaim } from "@/lib/db/queries/claims";
import { notifyOccupancy } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * Force free one claim.
 *
 * If its ticket is still at an occupying status the next Jira sync may re-claim
 * it. That is the documented behaviour rather than a bug — the board follows
 * Jira — and the confirmation dialog says so before this is called.
 */
export const DELETE = withApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("claim");

  const { id } = await ctx.params;
  const claimId = decodeURIComponent(id);

  // Read the environment before deleting, so the event can name it — the row is
  // gone by the time we would otherwise want to look.
  const owner = (await sql`SELECT server_id FROM claims WHERE id = ${claimId}`) as {
    server_id: string;
  }[];
  const serverId = owner[0]?.server_id;

  const result = await releaseClaim(claimId);
  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 404 });
  }

  await notifyOccupancy(
    "claim.released",
    { claimId, serverId: serverId ?? "" },
    { ...(serverId ? { serverId } : {}), socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true });
});
