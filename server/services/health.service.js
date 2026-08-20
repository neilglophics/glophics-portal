/**
 * Is each repository actually up?
 *
 * Every repo with a URL is pinged on a timer. Any HTTP response at all --
 * even a 404 or 500 -- counts as reachable; only a request that cannot
 * complete (DNS failure, connection refused, timeout) marks a repo offline.
 * A repo with no URL is "unconfigured", never "offline" -- there is nothing
 * to have failed.
 *
 * The write is one statement per changed repo, and only changed repos are
 * written or broadcast -- an all-green pass, which is the common case, writes
 * nothing and tells nobody anything.
 */

const { db } = require("../db/client.js");
const serversRepo = require("../repositories/servers.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS, MAX_DELTA_ENTITIES } = require("../realtime/events.js");

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

async function isUrlReachable(url) {
  if (!url) return false;
  try {
    await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    return true;
  } catch (err) {
    return false;
  }
}

async function runHealthChecks() {
  const checkable = await serversRepo.listCheckable(db);
  const unconfiguredCleared = await serversRepo.markUnconfigured(db);

  const results = await Promise.all(
    checkable.map(async (repo) => ({
      serverId: repo.server_id,
      repoName: repo.repo_name,
      health: (await isUrlReachable(repo.url)) ? "online" : "offline"
    }))
  );

  const changed = await serversRepo.applyHealth(db, results);
  if (!changed.length && !unconfiguredCleared) return { checked: results.length, changed: 0 };

  if (changed.length > MAX_DELTA_ENTITIES) {
    await bus.emit(EVENTS.INVALIDATE, { reason: "health-check" });
  } else if (changed.length) {
    await bus.emit(EVENTS.SERVER_REPO_HEALTH, { changes: changed });
  }

  return { checked: results.length, changed: changed.length };
}

module.exports = { runHealthChecks, HEALTH_CHECK_INTERVAL_MS };
