/**
 * The audit trail.
 *
 * Two write paths, deliberately:
 *
 *   record(tx, ...)  runs inside the caller's transaction. Used for anything
 *                    that changes state -- a role change and the record of it
 *                    commit together or not at all.
 *
 *   queue(...)       buffered, flushed on a timer. Used for the high-volume
 *                    rejection events (denied capability, blocked address,
 *                    failed sign-in). These must not add a database round-trip
 *                    to the act of saying no, and losing the last second of
 *                    them to a crash is an acceptable trade.
 *
 * `detail` is filtered through an allowlist of key names. A denylist of
 * ["password", "token"] fails the first time somebody names a field `newPass`;
 * an allowlist fails by dropping something useful, which is the direction you
 * want to fail in.
 */

const { db } = require("../db/client.js");
const auditRepo = require("../repositories/audit.repo.js");

const EVENTS = Object.freeze({
  LOGIN_SUCCEEDED: "auth.login.succeeded",
  LOGIN_FAILED: "auth.login.failed",
  LOGIN_THROTTLED: "auth.login.throttled",
  SPRAY_DETECTED: "auth.spray.detected",
  LOGOUT: "auth.logout",
  SESSION_REVOKED: "auth.session.revoked",
  PASSWORD_CHANGED: "auth.password.changed",
  PASSWORD_RESET: "auth.password.reset",
  PASSWORD_REHASHED: "auth.password.rehashed",

  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_ROLE_CHANGED: "user.role.changed",
  USER_ACTIVATED: "user.activated",
  USER_DEACTIVATED: "user.deactivated",
  USER_DELETED: "user.deleted",

  DIRECTORY_CREATED: "directory.created",
  DIRECTORY_UPDATED: "directory.updated",
  DIRECTORY_DELETED: "directory.deleted",

  CSRF_REJECTED: "csrf.rejected",
  AUTHZ_DENIED: "authz.denied",
  IP_BLOCKED: "ipallowlist.blocked",

  CLAIM_CREATED: "board.claimed",
  CLAIM_RELEASED: "board.released",
  ACCOUNT_CHANGED: "board.account.changed",
  SERVER_CHANGED: "board.server.changed",
  SETTINGS_CHANGED: "settings.changed",
  JIRA_CONFIG_CHANGED: "jira.config.changed",
  SECRET_ROTATED: "secret.rotated",
  ADMIN_SEEDED: "admin.seeded"
});

/** Key names permitted in `detail`. Everything else is silently dropped. */
const DETAIL_KEYS = new Set([
  "capability", "route", "reason", "role", "previousRole", "username", "previousUsername",
  "displayName", "boardName", "jobTitle", "jiraNames", "active", "previousActive",
  "sessionCount", "revokedSessions", "retryAfterMs", "distinctUsernames", "fields",
  "baseUrl", "email", "tokenChanged", "keyVersion", "paramsFrom", "paramsTo",
  "serverId", "serverName", "accountId", "accountName", "repos", "userIds",
  "claimId", "source", "count", "mode", "profile", "seq"
]);

function redact(detail) {
  const out = {};
  if (!detail || typeof detail !== "object") return out;
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(key)) continue;
    // Bound the size of anything that lands in the log. A 10,000-entry array
    // in `detail` would be a denial of service against the audit table.
    if (Array.isArray(value)) out[key] = value.slice(0, 50);
    else if (typeof value === "string") out[key] = value.slice(0, 500);
    else out[key] = value;
  }
  return out;
}

/** Pulls the actor fields out of a request context. */
function actorFrom(ctx) {
  if (!ctx) return {};
  return {
    actorUserId: ctx.user ? ctx.user.id : null,
    actorUsername: ctx.user ? ctx.user.username : null,
    actorRole: ctx.user ? ctx.user.role : null,
    actorIp: ctx.clientIp ?? null,
    actorSessionId: ctx.session ? ctx.session.id : null,
    actorUserAgent: ctx.userAgent ?? null
  };
}

function build(event, ctx, { outcome = "success", target = {}, detail = {}, actor = null } = {}) {
  return {
    ...actorFrom(ctx),
    ...(actor || {}),
    event,
    outcome,
    targetType: target.type ?? null,
    targetId: target.id ?? null,
    targetLabel: target.label ?? null,
    detail: redact(detail)
  };
}

/** Transaction-bound write. Fails the transaction if it fails. */
async function record(tx, event, ctx, options = {}) {
  await auditRepo.insert(tx, build(event, ctx, options));
}

// --------------------------------------------------------------- buffered --

const buffer = [];
const MAX_BUFFER = 500;
const FLUSH_INTERVAL_MS = 1000;
let flushTimer = null;
let flushing = false;

function queue(event, ctx, options = {}) {
  // Drop rather than grow without bound: if the database is unreachable, an
  // unbounded buffer turns a database outage into a memory exhaustion.
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push(build(event, ctx, options));
}

async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);
  try {
    await auditRepo.insertMany(db, batch);
  } catch (err) {
    console.error(`[audit] could not write ${batch.length} buffered entries: ${err.message}`);
  } finally {
    flushing = false;
  }
}

function start() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

async function stop() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  await flush();
}

// -------------------------------------------------------------- retention --

// The rejection events are high-volume and lose their value quickly; everything
// else answers "what changed, and who changed it" and is kept for a year and a
// quarter, so the same question can be asked about this time last year.
const SHORT_LIVED = [
  EVENTS.LOGIN_FAILED, EVENTS.LOGIN_THROTTLED, EVENTS.AUTHZ_DENIED,
  EVENTS.CSRF_REJECTED, EVENTS.IP_BLOCKED
];
const SHORT_RETENTION_DAYS = 90;
const LONG_RETENTION_DAYS = 400;

async function applyRetention() {
  const day = 24 * 60 * 60 * 1000;
  const short = await auditRepo.deleteOlderThan(
    db, new Date(Date.now() - SHORT_RETENTION_DAYS * day), SHORT_LIVED
  );
  const long = await auditRepo.deleteOlderThan(
    db, new Date(Date.now() - LONG_RETENTION_DAYS * day), null
  );
  return { short, long };
}

async function search(filters) {
  return auditRepo.search(db, filters);
}

module.exports = {
  EVENTS, record, queue, flush, start, stop, applyRetention, search, redact, actorFrom
};
