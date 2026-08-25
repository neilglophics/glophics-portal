/**
 * The health-check policy: how often a pass runs, how long a result stays
 * meaningful, and what a probe's outcome means.
 *
 * Pure and dependency-free on purpose. The runner in lib/health/check.ts needs
 * Postgres and the network; these rules need neither. That keeps them unit
 * testable (tests/health.test.ts) and lets the Server Component, the client
 * button and the cron route all read the SAME numbers — the legacy app had the
 * interval written into the job and the staleness threshold written into the
 * page, and the two drifted apart the moment the cadence changed.
 */

import type { RepoHealth } from "@/lib/types";

/**
 * How often a pass should run.
 *
 * ⚠ Cadence changed with the platform, exactly as it did for the Jira sync. The
 * legacy server pinged every 30 seconds because it was a long-lived process on
 * the same LAN. A serverless deployment has no process to hold a timer, so this
 * is driven by Vercel Cron (daily in vercel.json — the Hobby tier does not
 * schedule below a day, and nothing here is worth a paid tier on its own) and,
 * whenever anybody is signed in, by a timer in components/shell/HealthButton.tsx.
 * That timer is what actually delivers this interval: it lives in the Topbar,
 * which is in the app shell, so it ticks on every page rather than only while
 * somebody has /health open. The "Check servers" button and the header pill
 * itself cover "I need to know right now".
 */
export const HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** A probe that has not answered in this long counts as unreachable. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * The floor under an *unforced* pass.
 *
 * A pass is ~one outbound request per configured repository, so it is not free
 * for us or for the environments being pinged. Every open tab carries the header
 * timer, so they will each decide a pass is due at roughly the same moment; this
 * makes all but the first of them a no-op instead of a stampede. The button
 * bypasses it — somebody pressing it has a reason.
 */
export const HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How old the newest result may be before the page stops presenting it as true.
 *
 * Two missed hourly passes plus slack. One missed pass is a cold start or a
 * skipped cron tick and not worth a warning; two means whatever runs the checks
 * has stopped, and the states on screen are then a historical record rather than
 * a report.
 */
export const HEALTH_STALE_AFTER_MS = 2 * HEALTH_CHECK_INTERVAL_MS + 10 * 60 * 1000;

/**
 * What one probe means.
 *
 * Carried over verbatim from server/jobs/health.js, reasoning included: **any
 * HTTP response at all counts as reachable**, even a 404 or a 500. Only a
 * request that cannot complete — DNS failure, connection refused, TLS error,
 * timeout — marks a repository offline. A dev storefront answering 404 on `/` is
 * normal; a dev API answering 500 is a broken deploy, not a missing environment.
 * Offline outranks every other state on the board, so it has to mean "the box is
 * not there", not "the app returned something I did not like".
 *
 * No URL is not a failure. It is an environment nobody has finished configuring,
 * which is `unconfigured` — a repository with nothing to ping can never be down.
 */
export function probeHealth(url: string | null | undefined, reachable: boolean): RepoHealth {
  if (!url) return "unconfigured";
  return reachable ? "online" : "offline";
}

/** The most recent of a set of check timestamps, or null when none has run. */
export function newestCheck(times: (string | null | undefined)[]): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;

  for (const time of times) {
    if (!time) continue;
    const ms = new Date(time).getTime();
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
    newest = time;
  }

  return newest;
}

/** Milliseconds since a check, or null if it never happened. A clock skewed into
 *  the future reads as 0 rather than negative, so "just checked" never becomes
 *  "checked in -3 minutes". */
export function msSinceCheck(checkedAt: string | null | undefined, now = Date.now()): number | null {
  if (!checkedAt) return null;
  const ms = new Date(checkedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, now - ms);
}

/** Is another pass owed? Never having run counts as owed. */
export function isPassDue(checkedAt: string | null | undefined, now = Date.now()): boolean {
  const since = msSinceCheck(checkedAt, now);
  return since === null || since >= HEALTH_CHECK_INTERVAL_MS;
}

/** How long until one is owed. 0 when it is owed now — the caller can hand this
 *  straight to setTimeout. */
export function msUntilDue(checkedAt: string | null | undefined, now = Date.now()): number {
  const since = msSinceCheck(checkedAt, now);
  if (since === null) return 0;
  return Math.max(0, HEALTH_CHECK_INTERVAL_MS - since);
}

/** Too soon to repeat an unforced pass. */
export function isTooRecent(checkedAt: string | null | undefined, now = Date.now()): boolean {
  const since = msSinceCheck(checkedAt, now);
  return since !== null && since < HEALTH_MIN_INTERVAL_MS;
}

/** Old enough that the page must say so rather than present it as current. */
export function isStale(checkedAt: string | null | undefined, now = Date.now()): boolean {
  const since = msSinceCheck(checkedAt, now);
  return since !== null && since > HEALTH_STALE_AFTER_MS;
}
