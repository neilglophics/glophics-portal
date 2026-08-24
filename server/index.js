/**
 * Local sync server for the Glophics dashboard.
 *
 * This file is the wiring and nothing else: the gate, the routing table, the
 * boot-time migrations, and what gets printed on start. Every piece of work
 * it dispatches to lives beside it —
 *
 *   paths.js         where everything is on disk, resolved from the repo root
 *   board.js         the board in memory, plus persist() and broadcast()
 *   state-store.js   the board on disk, one file per section in shared-data/
 *   auth-store.js    credentials and sessions (config/auth.json)
 *   ip-allowlist.js  which addresses may reach any of this at all
 *   access.js        who is calling, and whether their role permits it
 *   static.js        the app's own files, from public/ and shared/ only
 *   jira-client.js   talking to Jira, and the API token that needs
 *   routes/          auth.js, state.js, jira.js — one per /api/ area
 *   jobs/            health.js, sync.js — the passes that run on a timer
 *
 * The order of the three checks below is the whole security model. The IP
 * allowlist comes first, ahead of routing and sessions and even the sign-in
 * screen, so a stranger gets one answer for every path. Then the sign-in
 * handshake, the only part of the API reachable without a session. Then
 * everything else, each route naming the capability it needs.
 *
 * Run: node server/index.js   (or npm start)
 * Then open http://localhost:4000 (or share that port via Live Share).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { ROOT, CONFIG_DIR } = require("./paths.js");
const Board = require("./board.js");
const StateStore = require("./state-store.js");
const Auth = require("./auth-store.js");
const IpAllowlist = require("./ip-allowlist.js");
const { sendJson } = require("./http.js");
const { currentUser } = require("./access.js");
const { serveStatic } = require("./static.js");

const authRoutes = require("./routes/auth.js");
const stateRoutes = require("./routes/state.js");
const jiraRoutes = require("./routes/jira.js");

const health = require("./jobs/health.js");
const sync = require("./jobs/sync.js");

const PORT = process.env.PORT || 4000;

// Handed to the routes that expose a "do it now" button for something the
// server already does on a timer.
const jobs = { runHealthChecks: health.runHealthChecks, runJiraSync: sync.runJiraSync };

/**
 * Credentials and connection settings used to sit in the repo root, beside
 * the code and inside the directory the static handler served from. They now
 * live in config/, which nothing serves — so move any that are still where
 * they were. Same shape as the shared-state.json split in state-store.js: the
 * next start relocates them, nobody has to remember to.
 */
function relocateConfigFiles() {
  const moved = [];
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  ["auth.json", "jira-config.json", "allowed-ips.json"].forEach((name) => {
    const from = path.join(ROOT, name);
    const to = path.join(CONFIG_DIR, name);
    if (!fs.existsSync(from)) return;
    // Never overwrite: if both exist, config/ is the live one and the copy in
    // the root is a leftover somebody should look at rather than lose.
    if (fs.existsSync(to)) {
      moved.push(`${name} — left in place, config/${name} already exists`);
      return;
    }
    try {
      fs.renameSync(from, to);
      moved.push(`${name} → config/${name}`);
    } catch (err) {
      moved.push(`${name} — could not be moved (${err.message})`);
    }
  });
  return moved;
}

// Before anything reads them. auth-store.js and ip-allowlist.js both read
// their file on every call, so this has to happen before the first request —
// and before seedIfEmpty() below, which would otherwise mint a second super
// admin against an empty config/auth.json.
const relocated = relocateConfigFiles();

// A sign-in account names the person behind it by pointing at the board's own
// directory rather than repeating them, so the credential store needs a way to
// read that directory (auth-store.js explains why it cannot simply require
// it). The arrow closes over the property, not today's value — POST
// /api/state replaces the whole board, and the link has to follow it.
Auth.useDirectory(() => Board.state.users);

// The very first run has no credentials file, so one super admin is minted
// here. Set ADMIN_USERNAME / ADMIN_PASSWORD to choose the credentials rather
// than taking the documented default.
const seeded = Auth.seedIfEmpty();

// Accounts written before accounts linked to the directory carried their own
// copy of the Jira names. Convert them now that the directory is readable —
// after the board is loaded, before anyone can sign in.
const relinked = Auth.linkAccountsToDirectory();

const server = http.createServer((req, res) => {
  // Ahead of routing, sessions and even the sign-in screen: an address that
  // isn't on the allowlist gets one answer for every path. The body says
  // nothing about what runs here — a refusal shouldn't confirm there's a
  // portal worth coming back for. See ip-allowlist.js.
  if (!IpAllowlist.allows(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const url = req.url.split("?")[0];

  // The sign-in handshake is the only part of the API a stranger reaches.
  if (authRoutes.routePublic(req, res, url)) return;

  if (url.startsWith("/api/")) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, 401, { ok: false, error: "Sign in to continue." });
      return;
    }
    // Each returns true once it has recognised the path and answered.
    if (authRoutes.route(req, res, url, user)) return;
    if (stateRoutes.route(req, res, url, user, jobs)) return;
    if (jiraRoutes.route(req, res, url, user, jobs)) return;

    sendJson(res, 404, { ok: false, error: "No such API route." });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Glophics running at http://localhost:${PORT}`);

  StateStore.describe().forEach(({ file, lines }) => {
    console.log(`  shared-data/${file.padEnd(14)} ${String(lines).padStart(5)} lines`);
  });

  if (relocated.length) {
    console.log("");
    console.log("  ┌─ Moved these out of the repo root, into config/ ───────────");
    relocated.forEach((line) => console.log(`  │  ${line}`));
    console.log("  │  Nothing serves that directory, so they are no longer");
    console.log("  │  sitting where a static request could reach them.");
    console.log("  └───────────────────────────────────────────────────────────");
  }

  if (relinked.linked.length) {
    console.log("");
    console.log("  ┌─ Linked these sign-in accounts to their directory entry ───");
    relinked.linked.forEach((line) => console.log(`  │  ${line}`));
    console.log("  └───────────────────────────────────────────────────────────");
  }
  if (relinked.unresolved.length) {
    // Silence here would leave somebody wondering why My tickets is empty,
    // so name the accounts whose old Jira names matched nobody — or matched
    // more than one person, which is not a link worth guessing at.
    console.log("");
    console.log("  ┌─ These accounts could not be linked automatically ────────");
    relinked.unresolved.forEach((line) => console.log(`  │  ${line}`));
    console.log("  │  Point each at the right person under Users → Edit.");
    console.log("  └───────────────────────────────────────────────────────────");
  }

  if (seeded && !seeded.isDefault) {
    console.log("");
    console.log("  ┌─ First run: super admin created from ADMIN_USERNAME/ADMIN_PASSWORD");
    console.log(`  │  username: ${seeded.username}`);
    console.log("  └───────────────────────────────────────────────────────────────────");
  } else if (Auth.usingDefaultPassword()) {
    // Printed on every start, not just the one that created the account —
    // the run that would have shown it once is usually the run nobody was
    // watching, which is how a default password quietly becomes permanent.
    console.log("");
    console.log("  ┌─ Sign in with the default credentials ─────────────────");
    console.log(`  │  username: ${Auth.DEFAULT_ADMIN_USERNAME}`);
    console.log(`  │  password: ${Auth.DEFAULT_ADMIN_PASSWORD}`);
    console.log("  │");
    console.log("  │  This default is in the README, so anyone who has seen");
    console.log("  │  the repo knows it. Change it under the avatar menu →");
    console.log("  │  Change password. This notice stops once you do.");
    console.log("  └────────────────────────────────────────────────────────");
  }

  if (IpAllowlist.isOpen()) {
    console.log("");
    console.log("  ┌─ No IP allowlist: every address that can reach this port ─");
    console.log("  │  may load the sign-in screen. Set ALLOWED_IPS, or fill in");
    console.log("  │  config/allowed-ips.json (copy allowed-ips.example.json),");
    console.log("  │  to let only your office/VPN addresses through.");
    console.log("  └───────────────────────────────────────────────────────────");
  } else {
    console.log(`IP allowlist on — ${IpAllowlist.describe()}.`);
  }

  // The passes that run without anyone asking. Started after listen rather
  // than at require time, so a boot that fails to bind the port doesn't leave
  // timers running against a server that never came up.
  health.runHealthChecks();
  setInterval(health.runHealthChecks, health.HEALTH_CHECK_INTERVAL_MS);
  setInterval(sync.runExpiryChecks, health.HEALTH_CHECK_INTERVAL_MS);
  sync.runJiraSync(true).catch(() => {});
  setInterval(() => sync.runJiraSync(false).catch(() => {}), 20000);

  console.log("");
  console.log("Share this port via VS Code Live Share (Shared Servers) so other viewers stay in sync.");
  console.log("Note: Live Share tunnels guests through the host, so they all arrive as loopback —");
  console.log("the allowlist can't tell them apart. It gates direct network access, not Live Share.");
});
