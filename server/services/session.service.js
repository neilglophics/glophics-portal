/**
 * Sessions: minting them, resolving them, and taking them away.
 *
 * The in-process cache below deserves an explanation, because a cache in front
 * of an authorization check is normally a bug.
 *
 * Every API request has to resolve a cookie to an account. Against a local file
 * that was microseconds; against a database it is a round-trip, on every
 * request, including every SSE frame's re-authorization. So resolved sessions
 * are cached for a few seconds.
 *
 * That is safe *here* because every revocation path in the application goes
 * through this module, and each one drops the affected entries from the cache
 * synchronously, in the same tick, before it returns. There is no window in
 * which this process will honour a session it has just revoked. The short TTL
 * exists only to bound revocations performed out of band -- by the CLI, or by
 * a second process if this is ever run as more than one.
 *
 * If this application ever does run as more than one process, this cache must
 * either be invalidated across processes or deleted. That is the whole caveat,
 * and it is why the TTL is seconds rather than minutes.
 */

const crypto = require("node:crypto");
const { db, tx } = require("../db/client.js");
const sessions = require("../repositories/auth-sessions.repo.js");
const authUsers = require("../repositories/auth-users.repo.js");
const { config } = require("../config.js");

const CACHE_TTL_MS = 5_000;
// How stale the idle marker must be before a request writes it. Without this,
// a tab holding a stream would produce a write per request and no benefit.
const TOUCH_AFTER_MS = 60_000;

/** tokenHashHex -> { resolved, cachedAt } */
const cache = new Map();
/** sessionId -> tokenHashHex, so a revocation can find its cache entry. */
const bySessionId = new Map();

function cacheKey(token) {
  return sessions.hashToken(token).toString("hex");
}

function putInCache(token, resolved) {
  const key = cacheKey(token);
  cache.set(key, { resolved, cachedAt: Date.now() });
  bySessionId.set(resolved.session.id, key);
}

function dropSessions(sessionIds) {
  for (const id of sessionIds) {
    const key = bySessionId.get(id);
    if (key) cache.delete(key);
    bySessionId.delete(id);
  }
}

function dropAllForUser(userId) {
  for (const [key, entry] of cache) {
    if (entry.resolved.user.id === userId) {
      bySessionId.delete(entry.resolved.session.id);
      cache.delete(key);
    }
  }
}

function clearCache() {
  cache.clear();
  bySessionId.clear();
}

function newToken() {
  // 32 bytes of uniform randomness. There is no dictionary against this, which
  // is why the stored form is a plain SHA-256 and not a slow KDF.
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Creates a session and returns the raw token exactly once.
 *
 * The caller sets it as a cookie; it is never stored, logged, or returned
 * again. Everything afterwards works from its hash.
 */
async function create(userId, { ip = null, userAgent = null } = {}) {
  const token = newToken();
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();

  const session = {
    id: crypto.randomUUID(),
    userId,
    token,
    csrfToken,
    idleExpiresAt: new Date(now + config.sessionIdleTtlMs),
    absoluteExpiresAt: new Date(now + config.sessionAbsoluteTtlMs),
    ip,
    userAgent
  };

  await sessions.insert(db, session);

  // Bound how many live sessions one account can hold. A laptop and a desktop
  // is normal; fifty is a replayed cookie, and the cap bounds how long it lasts.
  const live = await sessions.countLiveForUser(db, userId);
  if (live > config.sessionMaxPerUser) {
    const revoked = await sessions.revokeOldestBeyond(
      db, userId, config.sessionMaxPerUser, "session-limit"
    );
    dropSessions(revoked);
  }

  return { token, csrfToken, sessionId: session.id, expiresAt: session.absoluteExpiresAt };
}

/**
 * Resolves a cookie to `{ session, user }`, or null.
 *
 * Returns null for an expired session, a revoked one, and a deactivated
 * account alike -- the caller does not need to tell those apart, and neither
 * does whoever is holding the cookie.
 */
async function resolve(token) {
  if (!token || typeof token !== "string") return null;

  const key = cacheKey(token);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.resolved;
  }

  const row = await sessions.findLiveByToken(db, token);
  if (!row || !row.active) {
    cache.delete(key);
    return null;
  }

  const resolved = {
    session: row.session,
    user: authUsers.toPublicUser(row.user)
  };
  putInCache(token, resolved);

  // Slide the idle window, but only once the marker is genuinely stale.
  const lastSeen = new Date(row.session.lastSeenAt).getTime();
  if (Date.now() - lastSeen > TOUCH_AFTER_MS) {
    const idleExpiresAt = new Date(Date.now() + config.sessionIdleTtlMs);
    sessions
      .touch(db, row.session.id, idleExpiresAt, new Date(Date.now() - TOUCH_AFTER_MS))
      .catch(() => {});
  }

  return resolved;
}

/**
 * Cache-only lookup, for the per-frame re-authorization of an open stream.
 *
 * Returns undefined when it does not know, which the caller must treat as "ask
 * properly" rather than as "allowed".
 */
function resolveCached(sessionId) {
  const key = bySessionId.get(sessionId);
  if (!key) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) return undefined;
  return entry.resolved;
}

/** True if this session is still live. Used by the SSE hub on every frame. */
async function isLive(sessionId) {
  const cached = resolveCached(sessionId);
  if (cached) return true;
  const row = await db.one(
    `select 1 as live
       from auth_sessions s
       join auth_users u on u.id = s.user_id
      where s.id = ? and s.revoked_at is null
        and s.idle_expires_at > current_timestamp(3)
        and s.absolute_expires_at > current_timestamp(3)
        and u.active = 1`,
    [sessionId]
  );
  return Boolean(row);
}

async function revokeToken(token, reason) {
  const resolved = await resolve(token);
  const revoked = await sessions.revokeByToken(db, token, reason);
  cache.delete(cacheKey(token));
  if (resolved) bySessionId.delete(resolved.session.id);
  return revoked;
}

async function revokeById(sessionId, reason) {
  const revoked = await sessions.revokeById(db, sessionId, reason);
  dropSessions([sessionId]);
  return revoked;
}

/**
 * Revokes every session for an account.
 *
 * Called on password change, role change, and deactivation. The cache is
 * cleared before this returns, so the very next request on a revoked cookie is
 * refused by this process even though the database write has only just landed.
 */
async function revokeAllForUser(userId, reason, { exceptSessionId = null, executor = db } = {}) {
  const revoked = await sessions.revokeAllForUser(executor, userId, reason, exceptSessionId);
  dropAllForUser(userId);
  return revoked;
}

/** Removes long-dead rows. Kept well past expiry so the audit trail can still
 *  resolve a session id for anything recent. */
async function sweep(graceDays = 30) {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  return sessions.deleteExpiredBefore(db, cutoff);
}

module.exports = {
  create, resolve, resolveCached, isLive,
  revokeToken, revokeById, revokeAllForUser, sweep,
  clearCache, CACHE_TTL_MS
};
