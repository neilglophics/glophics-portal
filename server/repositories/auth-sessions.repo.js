/**
 * Sessions.
 *
 * The cookie value never reaches this table -- only its SHA-256. Lookups are
 * therefore *by* the hash, which means there is no secret-dependent comparison
 * anywhere in application code and nothing to get wrong about constant time.
 *
 * Revocation is a column, not a DELETE. The audit log points at session ids,
 * and a deleted row makes that trail unreadable exactly when somebody is trying
 * to read it.
 */

const crypto = require("node:crypto");
const { isoOrNull, bool } = require("../db/columns.js");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest();
}

const LIVE = `
  revoked_at is null
  and idle_expires_at > current_timestamp(3)
  and absolute_expires_at > current_timestamp(3)
`;

function toSession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    csrfToken: row.csrf_token,
    createdAt: isoOrNull(row.created_at),
    lastSeenAt: isoOrNull(row.last_seen_at),
    idleExpiresAt: isoOrNull(row.idle_expires_at),
    absoluteExpiresAt: isoOrNull(row.absolute_expires_at)
  };
}

async function insert(db, session) {
  await db.run(
    `insert into auth_sessions
       (id, user_id, token_sha256, csrf_token, idle_expires_at, absolute_expires_at,
        created_ip, user_agent)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id, session.userId, hashToken(session.token), session.csrfToken,
      session.idleExpiresAt, session.absoluteExpiresAt,
      session.ip ?? null, (session.userAgent || "").slice(0, 512) || null
    ]
  );
}

/**
 * Resolves a cookie to its session *and* its account in one query.
 *
 * The join is what makes deactivation take effect immediately: an account
 * switched off stops resolving on its next request, without anything having to
 * hunt down and revoke its sessions first.
 */
async function findLiveByToken(db, token) {
  const row = await db.one(
    `select s.id, s.user_id, s.csrf_token, s.created_at, s.last_seen_at,
            s.idle_expires_at, s.absolute_expires_at,
            u.username, u.display_name, u.role, u.directory_user_id,
            u.active, u.must_change_password, u.created_at as user_created_at,
            u.last_login_at
       from auth_sessions s
       join auth_users u on u.id = s.user_id
      where s.token_sha256 = ? and ${LIVE}`,
    [hashToken(token)]
  );
  if (!row) return null;
  return {
    session: toSession(row),
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      directory_user_id: row.directory_user_id,
      active: row.active,
      must_change_password: row.must_change_password,
      created_at: row.user_created_at,
      last_login_at: row.last_login_at
    },
    active: bool(row.active)
  };
}

/**
 * Slides the idle window forward.
 *
 * Guarded so a tab holding an SSE stream and polling does not produce a write
 * per request: the row is only touched once the recorded time is genuinely
 * stale. Without the guard this would be the busiest write in the system and
 * would buy nothing.
 */
async function touch(db, sessionId, idleExpiresAt, notBefore) {
  const result = await db.run(
    `update auth_sessions
        set last_seen_at = current_timestamp(3), idle_expires_at = ?
      where id = ? and last_seen_at < ?`,
    [idleExpiresAt, sessionId, notBefore]
  );
  return result.affectedRows > 0;
}

async function revokeById(db, sessionId, reason) {
  const result = await db.run(
    `update auth_sessions
        set revoked_at = current_timestamp(3), revoked_reason = ?
      where id = ? and revoked_at is null`,
    [reason, sessionId]
  );
  return result.affectedRows > 0;
}

async function revokeByToken(db, token, reason) {
  const result = await db.run(
    `update auth_sessions
        set revoked_at = current_timestamp(3), revoked_reason = ?
      where token_sha256 = ? and revoked_at is null`,
    [reason, hashToken(token)]
  );
  return result.affectedRows > 0;
}

/** Every live session for an account. Returns the ids, so the caller can drop
 *  them from any in-process cache without guessing which they were. */
async function revokeAllForUser(db, userId, reason, exceptSessionId = null) {
  const params = [userId];
  let where = "user_id = ? and revoked_at is null";
  if (exceptSessionId) { where += " and id <> ?"; params.push(exceptSessionId); }

  const rows = await db.many(`select id from auth_sessions where ${where}`, params);
  if (!rows.length) return [];

  await db.run(
    `update auth_sessions
        set revoked_at = current_timestamp(3), revoked_reason = ?
      where ${where}`,
    [reason, ...params]
  );
  return rows.map((row) => row.id);
}

async function countLiveForUser(db, userId) {
  const row = await db.one(
    `select count(*) as total from auth_sessions where user_id = ? and ${LIVE}`,
    [userId]
  );
  return Number(row.total);
}

/**
 * Revokes the oldest sessions beyond `keep`. A person legitimately has a laptop
 * and a desktop; an account with fifty live sessions is a stolen cookie being
 * replayed, and the cap bounds how long that lasts.
 */
async function revokeOldestBeyond(db, userId, keep, reason) {
  const rows = await db.many(
    `select id from auth_sessions
      where user_id = ? and ${LIVE}
      order by created_at desc
      limit 1000 offset ?`,
    [userId, keep]
  );
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  await db.run(
    `update auth_sessions
        set revoked_at = current_timestamp(3), revoked_reason = ?
      where id in (${ids.map(() => "?").join(", ")})`,
    [reason, ...ids]
  );
  return ids;
}

/** Hard-deletes long-dead rows. Kept well past expiry so the audit log can
 *  still resolve a session id for anything recent. */
async function deleteExpiredBefore(db, cutoff) {
  const result = await db.run("delete from auth_sessions where absolute_expires_at < ?", [cutoff]);
  return result.affectedRows;
}

module.exports = {
  hashToken, toSession, insert, findLiveByToken, touch,
  revokeById, revokeByToken, revokeAllForUser, countLiveForUser,
  revokeOldestBeyond, deleteExpiredBefore
};
