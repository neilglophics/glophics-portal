import { withApi } from "@/lib/auth/require";
import { requireCron } from "@/lib/cron";
import { getSettings } from "@/lib/db/queries/board";
import { releaseExpiredClaims } from "@/lib/db/queries/claims";
import { notifyOccupancy } from "@/lib/revalidate";

export const runtime = "nodejs";

/**
 * Time-based expiry. Independent of Jira, and only acts when `onExpiry` is
 * "auto-release" — "remind" and "remind-flag" are display-only, which the pages
 * handle themselves by colouring an overdue claim.
 *
 * This deletes claims, which is why requireCron() refuses when CRON_SECRET is
 * unset rather than running open.
 */
export const GET = withApi(async (req: Request) => {
  requireCron(req);

  const settings = await getSettings();
  const released = await releaseExpiredClaims(settings);

  if (released) await notifyOccupancy("claims.expired", { count: released });

  return Response.json({ ok: true, released, mode: settings.onExpiry });
});
