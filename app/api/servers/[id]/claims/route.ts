import { requireUser, withApi } from "@/lib/auth/require";
import { releaseServerClaims } from "@/lib/db/queries/claims";
import { notifyOccupancy } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/** Force free an entire environment — every claim on it at once. */
export const DELETE = withApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("claim");

  const { id } = await ctx.params;
  const serverId = decodeURIComponent(id);
  const result = await releaseServerClaims(serverId);

  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  // One event for the sweep, not one per claim: the client refetches the
  // environment either way, and a force-free of a fully-held box would
  // otherwise fan out several messages that say the same thing.
  await notifyOccupancy(
    "claim.released",
    { claimId: "*", serverId },
    { serverId, socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true, released: result.value.released });
});
