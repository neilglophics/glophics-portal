import { requireUser, withApi } from "@/lib/auth/require";
import { runJiraSync } from "@/lib/jira/sync";
import { notifyJiraSync } from "@/lib/revalidate";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Dashboard-driven sync that honours both the auto-sync switch and interval. */
export const POST = withApi(async () => {
    await requireUser("view");

    const result = await runJiraSync(false);

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
