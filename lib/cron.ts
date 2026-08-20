import { HttpError } from "@/lib/auth/require";

/**
 * Cron routes are public URLs on a public deployment. Without this check anyone
 * who guesses the path can trigger a Jira sync or an expiry sweep at will — and
 * the expiry sweep deletes claims.
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
 * set. That is the only accepted credential; there is no cookie path, because a
 * cron invocation has no user.
 *
 * If CRON_SECRET is unset this REFUSES rather than allowing. An unauthenticated
 * destructive endpoint is worse than a cron job that visibly does not run.
 */
export function requireCron(req: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new HttpError(503, "CRON_SECRET is not configured, so scheduled jobs are disabled.");
  }

  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  // Length check first, then a constant-time-ish comparison. Node's
  // timingSafeEqual needs equal lengths, and the header is attacker-controlled.
  if (header.length !== expected.length || !timingSafeEqualStrings(header, expected)) {
    throw new HttpError(401, "Not authorised.");
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
