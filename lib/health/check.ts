/**
 * Is each repository actually up?
 *
 * The port of server/jobs/health.js. The job it does is unchanged — ping every
 * repository that has a URL, write `online` / `offline` / `unconfigured` — but
 * three things about the platform changed how it does it:
 *
 *   1. THERE IS NO LOOP. The legacy job was a setInterval inside a long-lived
 *      process. A serverless function is invoked and then gone, so a pass is
 *      triggered from outside: hourly by Vercel Cron (app/api/cron/health), on
 *      demand by the button (app/api/health/check), and by a timer in the Health
 *      page while somebody has it open. Cadence lives in lib/shared/health.ts.
 *
 *   2. THE CHECK TIME IS RECORDED, NOT JUST THE RESULT. `health_checked_at` is
 *      what separates "this repository is up" from "this repository was up at
 *      some point, and nothing has looked since". The legacy app stored only the
 *      verdict and so could not tell the difference; on a schedule this coarse
 *      that difference is the whole story, and the Health page reads it to
 *      decide whether to trust what it is showing.
 *
 *   3. PROBES ARE POOLED. Ninety-odd `fetch` calls fired at once was fine on a
 *      LAN with no wall clock over it. A function has a duration limit, so the
 *      pass runs a bounded number at a time and finishes well inside it.
 *
 * ── On reaching these hosts at all ──
 *
 * docs/06-OPEN-QUESTIONS.md Q1 assumed private hostnames a cloud function cannot
 * resolve. Every URL actually configured on this board is a public dev domain
 * (dev-api.musticker.com and friends), so a Vercel function reaches them the
 * same way a browser does and no on-prem reporting agent is needed. If an
 * environment on a genuinely internal hostname is ever added, its repositories
 * will read `offline` from the cloud while being perfectly healthy — that is the
 * failure Q1 describes, and the answer to it is Option A, not a change here.
 */

import { sql } from "@/lib/db/client";
import { HEALTH_CHECK_TIMEOUT_MS, isTooRecent, newestCheck, probeHealth } from "@/lib/shared/health";
import type { RepoHealth } from "@/lib/types";

/**
 * How many probes are in flight at once.
 *
 * Worst case for a pass is ceil(repos / this) × the timeout — at ~93 repos and
 * 16 at a time that is six waves of at most 5s, comfortably inside the 60s
 * `maxDuration` the routes declare. Raising it shortens the pass and raises the
 * burst these dev boxes see from us; the current board does not need it.
 */
const PROBE_CONCURRENCY = 16;

export interface HealthChange {
  serverId: string;
  repoName: string;
  health: RepoHealth;
}

export interface HealthPass {
  ok: true;
  /** True when an unforced pass found a recent enough result and did nothing.
   *  Everything below then describes that earlier pass, not this call. */
  skipped: boolean;
  /** When the results now in the database were measured. */
  checkedAt: string | null;
  /** Repositories with a URL, i.e. the ones actually probed. */
  probed: number;
  online: number;
  offline: number;
  unconfigured: number;
  /** Only the repositories whose health is different from before. This is what
   *  goes over the wire; a pass where nothing changed sends an empty list. */
  changed: HealthChange[];
  durationMs: number;
}

interface RepoRow {
  server_id: string;
  repo_name: string;
  url: string | null;
  health: RepoHealth;
  health_checked_at: string | null;
}

/**
 * Run one pass and write the results.
 *
 * `force` bypasses the "somebody just did this" floor. The button forces; the
 * page timer and every other automatic caller does not.
 */
export async function runHealthChecks({ force = false } = {}): Promise<HealthPass> {
  const startedAt = Date.now();

  const rows = (await sql`
    SELECT server_id, repo_name, url, health, health_checked_at
      FROM server_repos
  `) as RepoRow[];

  const previousCheck = newestCheck(rows.map((r) => r.health_checked_at));

  if (!force && isTooRecent(previousCheck)) {
    return {
      ok: true,
      skipped: true,
      checkedAt: previousCheck,
      probed: rows.filter((r) => r.url).length,
      online: rows.filter((r) => r.health === "online").length,
      offline: rows.filter((r) => r.health === "offline").length,
      unconfigured: rows.filter((r) => r.health === "unconfigured").length,
      changed: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const results = await pooled(rows, PROBE_CONCURRENCY, async (row) => ({
    serverId: row.server_id,
    repoName: row.repo_name,
    was: row.health,
    health: probeHealth(row.url, row.url ? await isReachable(row.url) : false),
  }));

  const checkedAt = new Date().toISOString();

  if (results.length) {
    // One statement rather than a hundred round trips. The three arrays are
    // positional — unnest zips them back into rows — so they are each derived
    // from the same list in the same order.
    await sql`
      UPDATE server_repos sr
         SET health = v.health,
             -- A repository with no URL has not been checked, because there was
             -- nothing to check. Nulling it here also self-corrects a repo whose
             -- URL was removed after an earlier pass had stamped it.
             health_checked_at = CASE WHEN v.health = 'unconfigured' THEN NULL ELSE now() END
        FROM unnest(
               ${results.map((r) => r.serverId)}::text[],
               ${results.map((r) => r.repoName)}::text[],
               ${results.map((r) => r.health)}::text[]
             ) AS v(server_id, repo_name, health)
       WHERE sr.server_id = v.server_id
         AND sr.repo_name = v.repo_name
    `;
  }

  const changed: HealthChange[] = results
    .filter((r) => r.health !== r.was)
    .map(({ serverId, repoName, health }) => ({ serverId, repoName, health }));

  const pass: HealthPass = {
    ok: true,
    skipped: false,
    checkedAt,
    probed: results.filter((r) => r.health !== "unconfigured").length,
    online: results.filter((r) => r.health === "online").length,
    offline: results.filter((r) => r.health === "offline").length,
    unconfigured: results.filter((r) => r.health === "unconfigured").length,
    changed,
    durationMs: Date.now() - startedAt,
  };

  // The function log is the only record of a pass that changed nothing, and
  // "did it even run?" is the first question asked when the board looks wrong.
  console.info(
    `[health] ${pass.online} online, ${pass.offline} offline, ${pass.unconfigured} unconfigured, ` +
      `${changed.length} changed in ${pass.durationMs}ms`,
  );

  return pass;
}

/**
 * One probe. Never throws — a probe failing IS the result, and one unreachable
 * host must not abort the pass for the other ninety.
 */
async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      // Next patches global fetch. A cached probe would report the health of
      // whenever the response was first stored, which is worse than no check.
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      headers: { "user-agent": "glophics-portal/health-check" },
    });
    // Nothing reads the body, and an unconsumed one holds its socket open until
    // the GC gets to it — with 16 in flight that is a slow leak across a pass.
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Map with a ceiling on how many run at once. Results come back in input order,
 * which is what lets the caller zip them against the rows it started with.
 */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
}
