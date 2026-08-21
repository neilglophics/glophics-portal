import { withApi } from "@/lib/auth/require";
import { requireCron } from "@/lib/cron";
import { runHealthChecks } from "@/lib/health/check";
import { notifyHealth } from "@/lib/revalidate";

export const runtime = "nodejs";
/** ~93 probes at 16 in flight with a 5s timeout — six waves, worst case ~30s. */
export const maxDuration = 60;

/**
 * The scheduled health pass. Declared in vercel.json.
 *
 * ⚠ CADENCE IS A BILLING FACT, NOT A DESIGN ONE. The legacy server pinged every
 * 30 seconds because it was a process that could hold a timer. Vercel's Hobby
 * tier only schedules a cron **once a day** — that restriction is what commit
 * 3bb8d0f ("fix: vercel cron job issue") was: every job in this file had to be
 * moved off a per-minute schedule onto a daily one. So this entry is daily too,
 * and on Pro it becomes hourly by changing its schedule to "0 * * * *" and
 * nothing else.
 *
 * Hourly checking therefore comes from the OTHER two triggers: the timer in
 * components/health/HealthActions.tsx, which asks for a pass whenever the newest
 * result is over an hour old while somebody has /health open, and the "Check
 * servers" button for when even that is too slow. This job is the backstop that
 * runs when nobody is looking. See docs/06-OPEN-QUESTIONS.md Q1.
 *
 * force: true — the schedule *is* the throttle here, exactly as in
 * /api/cron/jira-sync. Honouring the unforced floor as well would let a manual
 * check a few minutes earlier cancel a scheduled pass and stretch the real gap
 * to two hours.
 */
export const GET = withApi(async (req: Request) => {
  requireCron(req);

  const pass = await runHealthChecks({ force: true });

  // No socketId: a cron invocation has no acting tab to exclude.
  await notifyHealth({ checkedAt: pass.checkedAt!, changed: pass.changed });

  return Response.json(pass);
});
