import { revalidatePath } from "next/cache";
import { requireUser, withApi } from "@/lib/auth/require";
import { releaseClaim } from "@/lib/db/queries/claims";

export const runtime = "nodejs";

const BOARD_PATHS = ["/dashboard", "/environments", "/tickets", "/my-tickets", "/in-use"];

/**
 * Force free one claim.
 *
 * If its ticket is still at an occupying status the next Jira sync may re-claim
 * it. That is the documented behaviour rather than a bug — the board follows
 * Jira — and the confirmation dialog says so before this is called.
 */
export const DELETE = withApi(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("claim");

  const { id } = await ctx.params;
  const result = await releaseClaim(decodeURIComponent(id));

  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 404 });
  }

  for (const path of BOARD_PATHS) revalidatePath(path);
  revalidatePath("/environments/[serverId]", "page");

  return Response.json({ ok: true });
});
