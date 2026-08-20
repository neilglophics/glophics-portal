import { requireUser, withApi } from "@/lib/auth/require";
import { runJiraSync } from "@/lib/jira/sync";
import { notifyJiraSync } from "@/lib/revalidate";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sync on demand.
 *
 * Only needs `view`: refreshing what the server already polls on its own changes
 * nothing a viewer could not already see — it only asks for it sooner. That was
 * the legacy reasoning and it still holds.
 *
 * This matters more than it used to. Cron cannot go below a minute, so this
 * button is now the only way to get sub-minute freshness.
 */
export const POST = withApi(async () => {
  await requireUser("view");

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
