import { withApi } from "@/lib/auth/require";
import { requireCron } from "@/lib/cron";
import { pruneExpiredSessions } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * Daily housekeeping.
 *
 * Right now that is only expired sessions and stale lockout rows. `resolveSession`
 * checks `expires_at` itself and never trusts this to have run, so a missed pass
 * costs disk, not correctness.
 *
 * Phase 11 adds attachment-blob reconciliation here: a hard-deleted message must
 * take its Vercel Blob with it, or the storage bill accumulates orphans nobody
 * can find. Phase 8 adds message retention per docs/06-OPEN-QUESTIONS.md Q8.
 */
export const GET = withApi(async (req: Request) => {
  requireCron(req);

  const sessions = await pruneExpiredSessions();

  const lockouts = (await sql`
    DELETE FROM auth_login_attempts
     WHERE locked_until IS NOT NULL AND locked_until < now() - interval '1 day'
     RETURNING username
  `) as unknown[];

  // Rows for windows nobody is inside any more. The limiter itself restarts an
  // elapsed window on next use, so these are dead weight rather than state.
  const limits = (await sql`
    DELETE FROM rate_limits WHERE window_start < now() - interval '1 day' RETURNING key
  `) as unknown[];

  return Response.json({
    ok: true,
    sessionsPruned: sessions,
    lockoutsCleared: lockouts.length,
    rateLimitRowsCleared: limits.length,
  });
});
