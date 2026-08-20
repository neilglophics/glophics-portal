/**
 * Is each repository actually up?
 *
 * Every repo with a URL is pinged on a timer and its `health` set to
 * "online" or "offline"; any repo down makes its environment read as "Needs
 * attention". A repo with no URL stays "unconfigured" — nothing to ping.
 */

const Board = require("../board.js");

// Every server hosts all of its account's repos at once, each with its own
// URL — ping each independently. Any HTTP response at all (even 404/500)
// counts as reachable; only a request that can't complete (DNS failure,
// connection refused, timeout) marks that repo offline.

const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

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
  const checks = [];
  Board.state.servers.forEach((server) => {
    Object.keys(server.repos).forEach((repoName) => {
      const url = server.repos[repoName].url;
      // No URL yet isn't a failure to report as "offline" — it's just not
      // set up. Only a URL that's actually there and unreachable counts.
      if (!url) {
        checks.push(Promise.resolve({ serverId: server.id, repoName, health: "unconfigured" }));
        return;
      }
      checks.push(
        isUrlReachable(url).then((reachable) => ({
          serverId: server.id,
          repoName,
          health: reachable ? "online" : "offline"
        }))
      );
    });
  });

  const results = await Promise.all(checks);
  let changed = false;
  results.forEach(({ serverId, repoName, health }) => {
    const server = Board.state.servers.find((s) => s.id === serverId);
    if (server && server.repos[repoName] && server.repos[repoName].health !== health) {
      server.repos[repoName].health = health;
      changed = true;
    }
  });
  if (changed) { Board.persist(); Board.broadcast(); }
}

module.exports = { runHealthChecks, HEALTH_CHECK_INTERVAL_MS };
