import { withApi } from "@/lib/auth/require";
import { requireCron } from "@/lib/cron";
import { runJiraSync } from "@/lib/jira/sync";
import { notifyJiraSync } from "@/lib/revalidate";

export const runtime = "nodejs";
/** The sync pages up to 500 issues plus a field-map lookup. */
export const maxDuration = 60;

/**
 * The scheduled Jira sync. Declared in vercel.json.
 *
 * ⚠ Cadence changed with the platform. The legacy server ticked every 20 seconds
 * and throttled internally to `pollIntervalMinutes`. Vercel Cron cannot go below
 * one minute (and the Hobby tier is far coarser — verify per plan), so worst-case
 * staleness is now about a minute. The "Sync now" button remains for on-demand
 * freshness. See docs/06-OPEN-QUESTIONS.md Q10.
 */
export const GET = withApi(async (req: Request) => {
  requireCron(req);

  // force: true — the schedule *is* the throttle now, so honouring
  // pollIntervalMinutes here as well would just skip runs.
  const result = await runJiraSync(true);

  if (result.ok) {
    await notifyJiraSync({
      lastSyncAt: new Date().toISOString(),
      issueCount: result.issueCount ?? 0,
      claimed: result.claimed ?? 0,
      released: result.released ?? 0,
      skippedCount: result.skippedCount ?? 0,
    });
  }

  return Response.json(result);
});
