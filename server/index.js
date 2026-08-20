/**
 * Local sync server for the Server Management dashboard.
 *
 * This file is the wiring and nothing else: the gate, the routing table, the
 * boot-time migrations, and what gets printed on start. Every piece of work it
 * dispatches to lives beside it --
 *
 *   config.js          every environment variable, resolved and validated once
 *   db/                 the connection pool, migrations, query helpers
 *   repositories/       the only layer that contains SQL
 *   services/           business rules -- no SQL, no req/res
 *   http/               the request pipeline: cookies, CSRF, the route table
 *   routes/             thin handlers, one file per API area
 *   realtime/            the event bus and the SSE transport
 *   jobs/               the passes that run on a timer
 *   ip-allowlist.js     which addresses may reach any of this at all
 *   static.js           the app's own files, from public/ and shared/ only
 *
 * The order of checks in the pipeline is the whole security model: the IP
 * allowlist runs first, ahead of routing and sessions and even the sign-in
 * screen, so a stranger gets one answer for every path. Then session
 * resolution. Then CSRF. Then the forced-password-change gate. Then the
 * capability the matched route names. See server/http/pipeline.js.
 *
 * Run: node server/index.js   (or npm start)
 * Then open http://localhost:<PORT>.
 */

const http = require("http");

const { config, assertValid } = require("./config.js");
const migrate = require("./db/migrate.js");
const dbClient = require("./db/client.js");
const IpAllowlist = require("./ip-allowlist.js");
const { serveStatic } = require("./static.js");

const { Router } = require("./http/router.js");
const { buildRoutes } = require("./http/routes-table.js");
const pipeline = require("./http/pipeline.js");
const { sendJson, sendText, baseHeaders } = require("./http/send.js");
const { toResponse, isExpected } = require("./http/errors.js");

const { SseHub } = require("./realtime/sse.js");
const sessionService = require("./services/session.service.js");
const bootstrap = require("./services/bootstrap.service.js");
const auditService = require("./services/audit.service.js");
const throttleService = require("./services/throttle.service.js");

const healthJob = require("./jobs/health.job.js");
const jiraSyncJob = require("./jobs/jira-sync.job.js");
const expiryJob = require("./jobs/expiry.job.js");
const janitorJob = require("./jobs/janitor.job.js");
const scheduler = require("./jobs/scheduler.js");

async function main() {
  assertValid();

  console.log("[boot] applying migrations…");
  const applied = await migrate.run({ log: (line) => console.log(`  ${line}`) });

  const seeded = await bootstrap.seedIfEmpty();
  const roleCheck = await bootstrap.assertRolesValid();

  throttleService.useGateStatus(() => IpAllowlist.isOpen());
  auditService.start();

  const sseHub = new SseHub({
    authorize: async (stream) => {
      if (!IpAllowlist.allows(stream.req)) return false;
      return sessionService.isLive(stream.sessionId);
    }
  });
  sseHub.start();

  const router = new Router(buildRoutes({ sseHub }));

  const server = http.createServer((req, res) => {
    handleRequest(req, res, router).catch((err) => {
      console.error("[http] unhandled error:", err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Something went wrong on the server." });
    });
  });

  // A malformed cookie value or a client that vanishes mid-request must not
  // take the whole process down with it -- this is the backstop for anything
  // that still slips past the pipeline's own error handling.
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(config.port, () => {
    printBanner({ applied, seeded, roleCheck });

    healthJob.start();
    jiraSyncJob.start();
    expiryJob.start();
    janitorJob.start();
  });

  const shutdown = async (signal) => {
    console.log(`\n[boot] ${signal} received, shutting down…`);
    scheduler.stopAll();
    sseHub.stop();
    server.close();
    await auditService.stop();
    await dbClient.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function handleRequest(req, res, router) {
  // Ahead of routing, sessions and even the sign-in screen: an address that
  // is not on the allowlist gets one answer for every path. The body says
  // nothing about what runs here -- a refusal should not confirm there is a
  // portal worth coming back for. See ip-allowlist.js.
  if (!IpAllowlist.allows(req)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const pathname = req.url.split("?")[0];

  if (!pathname.startsWith("/api/")) {
    serveStatic(req, res);
    return;
  }

  const clientIp = IpAllowlist.clientIp(req);
  const trustProxy = IpAllowlist.trustProxyHops() > 0;
  const ctx = pipeline.createContext(req, res, { clientIp, trustProxy });

  const matched = router.match(req.method, pathname);
  if (!matched) {
    sendJson(res, 404, { ok: false, error: "No such API route." });
    return;
  }
  if (matched.methodNotAllowed) {
    sendJson(res, 405, { ok: false, error: "Method not allowed." },
      { Allow: router.allowedMethods(pathname).join(", ") });
    return;
  }

  try {
    const body = await pipeline.run(ctx, matched.route, matched.params);
    // headersSent, not writableEnded: an SSE stream sends headers and its
    // first frame, then deliberately stays open for hours — writableEnded
    // would stay false for its entire lifetime, and this branch would try to
    // write a second, conflicting response on top of a connection the stream
    // handler is still using. That crashed the process outright: writeHead
    // throws synchronously when headers are already sent, escaping the
    // surrounding try/catch here because it happened on a later request
    // reusing this same handler path, not this one — but the effect was the
    // same, an uncaught exception with nothing left to catch it.
    if (res.headersSent) return;
    sendJson(res, 200, body === undefined ? { ok: true } : body);
  } catch (err) {
    if (res.headersSent) {
      // The response is already committed (a stream, most likely) — there is
      // nothing left to send, and writing again is exactly the crash this
      // guard exists to prevent.
      console.error(`[http] ${req.method} ${pathname} -> error after headers sent:`, err);
      return;
    }
    const { status, body } = toResponse(err);
    if (!isExpected(err)) console.error(`[http] ${req.method} ${pathname} ->`, err);
    sendJson(res, status, body);
  }
}

function printBanner({ applied, seeded, roleCheck }) {
  console.log(`Server Management running at http://localhost:${config.port}`);
  console.log(`  database: ${config.database.host}:${config.database.port}/${config.database.database}`);
  console.log(`  cookies: ${config.cookieSecure === "auto" ? "Secure decided per-request" : `Secure forced ${config.cookieSecure}`}`);

  if (applied.length) {
    console.log(`  migrations applied this run: ${applied.join(", ")}`);
  }

  if (seeded) {
    console.log("");
    console.log("  ┌─ First run: a super admin account was created ─────────────");
    console.log(`  │  username: ${seeded.username}`);
    if (seeded.source === "generated") {
      console.log(`  │  password: ${seeded.password}`);
      console.log("  │  Generated because ADMIN_PASSWORD was not set. This will not");
      console.log("  │  be shown again — write it down, or sign in and change it now.");
    } else {
      console.log("  │  password: (from ADMIN_PASSWORD)");
    }
    console.log("  │  You will be asked to set a new password on first sign-in.");
    console.log("  └──────────────────────────────────────────────────────────────");
  }

  if (roleCheck.unknownRoles.length) {
    console.log("");
    console.log(`  ┌─ ${roleCheck.unknownRoles.length} account(s) carry an unrecognised role ─────────`);
    console.log(`  │  ${roleCheck.unknownRoles.join(", ")}`);
    console.log("  │  They can sign in but have no permissions until corrected.");
    console.log("  └──────────────────────────────────────────────────────────────");
  }

  if (IpAllowlist.isOpen()) {
    console.log("");
    console.log("  ┌─ No IP allowlist: every address that can reach this port ─");
    console.log("  │  may load the sign-in screen. Set ALLOWED_IPS, or fill in");
    console.log("  │  config/allowed-ips.json (copy allowed-ips.example.json),");
    console.log("  │  to let only your office/VPN addresses through.");
    console.log("  │  The sign-in throttle is tightened automatically while this");
    console.log("  │  is open — see AUTH_THROTTLE_PROFILE in the README.");
    console.log("  └───────────────────────────────────────────────────────────");
  } else {
    console.log(`IP allowlist on — ${IpAllowlist.describe()}.`);
  }

  console.log("");
  console.log("Share this port via VS Code Live Share (Shared Servers) so other viewers stay in sync.");
  console.log("Note: Live Share tunnels guests through the host, so they all arrive as loopback —");
  console.log("the allowlist can't tell them apart, and neither can the per-address sign-in throttle.");
}

main().catch((err) => {
  console.error("[boot] failed to start:", err.message);
  process.exitCode = 1;
});
