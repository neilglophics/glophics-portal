/**
 * The board itself: reading it, replacing it, and the live stream that pushes
 * every change to open tabs.
 *
 * POST /api/state takes the whole board rather than a patch. That is what
 * makes two people editing at once survivable — the browser is the one place
 * that knows what the board should look like after an action, and the server
 * arbitrates rather than merges. What it will not take on trust is either of
 * the two things below: the sync's own keys, and anything a role isn't
 * allowed to move.
 */

const Auth = require("../auth-store.js");
const { sendJson, readBody } = require("../http.js");
const { allows } = require("../access.js");
const Board = require("../board.js");
const { JIRA_DERIVED_KEYS } = require("../../shared/data.js");

function handleGet(res) {
  sendJson(res, 200, Board.state);
}

function handlePost(req, res, user) {
  readBody(req).then((parsed) => {
    if (!parsed.users || !parsed.accounts || !parsed.servers) {
      sendJson(res, 400, { ok: false, error: "Invalid state payload" });
      return;
    }
    if (!Array.isArray(parsed.tickets)) parsed.tickets = [];
    if (!parsed.notes) parsed.notes = {};
    // The sync owns these, not whoever posted. A browser echoes back the
    // copy it was last pushed, which is at best equal and at worst a beat
    // behind — either way the server's own is the one to keep.
    JIRA_DERIVED_KEYS.forEach((key) => { parsed[key] = Board.state[key]; });
    if (!parsed.settings) parsed.settings = Board.state.settings;

    // A role that can claim but not configure may move claims and notes,
    // nothing else. Their whole appData still arrives on every save, so
    // rather than reject the payload — their copy of the config can be a
    // beat stale through no fault of theirs — keep the server's config
    // and take only the parts they are allowed to move.
    if (!Auth.roleCan(user.role, "configure")) {
      parsed.users = Board.state.users;
      parsed.accounts = Board.state.accounts;
      parsed.servers = Board.state.servers;
      parsed.settings = Board.state.settings;
    }

    Board.state = parsed;
    Board.persist();
    Board.broadcast();
    sendJson(res, 200, { ok: true });
  }).catch(() => sendJson(res, 400, { ok: false, error: "Invalid state payload" }));
}

// One long-lived response per watching tab. The first frame is the board as
// it stands, so a tab that has just connected does not wait for someone else
// to change something before it has anything to draw.
function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.write(`data: ${JSON.stringify(Board.state)}\n\n`);
  Board.sseClients.add(res);
  req.on("close", () => Board.sseClients.delete(res));
}

function route(req, res, url, user, jobs) {
  if (url === "/api/state" && req.method === "GET") {
    if (!allows(res, user, "view")) return true;
    handleGet(res);
    return true;
  }
  if (url === "/api/state" && req.method === "POST") {
    if (!allows(res, user, "claim")) return true;
    handlePost(req, res, user);
    return true;
  }
  if (url === "/api/events" && req.method === "GET") {
    if (!allows(res, user, "view")) return true;
    handleStream(req, res);
    return true;
  }

  // Refreshing what the server already polls on its own changes nothing a
  // viewer couldn't already see — it only asks for it sooner.
  if (url === "/api/health/check-now" && req.method === "POST") {
    if (!allows(res, user, "view")) return true;
    jobs.runHealthChecks()
      .then(() => sendJson(res, 200, { ok: true }))
      .catch(() => sendJson(res, 200, { ok: false, error: "Health check failed." }));
    return true;
  }

  return false;
}

module.exports = { route };
