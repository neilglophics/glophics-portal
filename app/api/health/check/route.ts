import { requireUser, withApi } from "@/lib/auth/require";
import { runHealthChecks } from "@/lib/health/check";
import { requireWithinLimit } from "@/lib/rate-limit";
import { notifyHealth } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Check the servers now.
 *
 * POST, not GET. There are no CSRF tokens in this app — `SameSite=Lax` is what
 * carries that protection, and it only holds for non-GET methods. This writes to
 * server_repos, so it must never become a GET, however convenient a link would
 * be for testing.
 *
 * ── Why `view` and not `claim` ──
 *
 * The same reasoning as /api/jira/sync-now: refreshing something the schedule
 * already does on its own changes nothing a viewer could not already see — it
 * only asks for it sooner. The legacy app ran these checks for everybody without
 * asking who was looking. A rate limit, not a capability, is the right guard for
 * an endpoint whose only risk is volume.
 *
 * ── force ──
 *
 * `?force=1` skips the "somebody checked a minute ago" floor. The button sends
 * it, because a person pressing it wants a measurement and not a cached verdict.
 * The Health page's hourly timer does not, so several open tabs coalesce into
 * one pass instead of one each.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser("view");
  await requireWithinLimit("health.check", user.id);

  const force = new URL(req.url).searchParams.get("force") === "1";
  const pass = await runHealthChecks({ force });

  // A skipped pass measured nothing, so there is nothing to announce — the
  // results other tabs hold are already the ones this call decided to keep.
  if (!pass.skipped) {
    await notifyHealth(
      { checkedAt: pass.checkedAt!, changed: pass.changed },
      { socketId: socketIdFrom(req) },
    );
  }

  return Response.json(pass);
});
