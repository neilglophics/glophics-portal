/**
 * The audit log.
 *
 * Insert and read. There is no update and no single-row delete anywhere in this
 * file by design -- the only removal is the retention sweep at the bottom, and
 * keeping it here alone makes "can anything rewrite history?" answerable by
 * reading one file.
 */

const { toJson, jsonObject, isoOrNull } = require("../db/columns.js");

async function insert(db, entry) {
  await db.run(
    `insert into audit_log
       (actor_user_id, actor_username, actor_role, actor_ip, actor_session_id,
        actor_user_agent, event, outcome, target_type, target_id, target_label, detail)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.actorUserId ?? null,
      entry.actorUsername ?? null,
      entry.actorRole ?? null,
      entry.actorIp ?? null,
      entry.actorSessionId ?? null,
      (entry.actorUserAgent || "").slice(0, 512) || null,
      entry.event,
      entry.outcome || "success",
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.targetLabel ?? null,
      toJson(entry.detail || {})
    ]
  );
}

/** Batched insert for the buffered path. One statement, many rows. */
async function insertMany(db, entries) {
  if (!entries.length) return;
  const columns = `
    (actor_user_id, actor_username, actor_role, actor_ip, actor_session_id,
     actor_user_agent, event, outcome, target_type, target_id, target_label, detail)`;
  const placeholders = entries.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = [];
  for (const entry of entries) {
    params.push(
      entry.actorUserId ?? null, entry.actorUsername ?? null, entry.actorRole ?? null,
      entry.actorIp ?? null, entry.actorSessionId ?? null,
      (entry.actorUserAgent || "").slice(0, 512) || null,
      entry.event, entry.outcome || "success",
      entry.targetType ?? null, entry.targetId ?? null, entry.targetLabel ?? null,
      toJson(entry.detail || {})
    );
  }
  // Deliberately query(), not execute(): a prepared statement whose parameter
  // count changes with every call would thrash the driver's statement cache.
  await db.query(`insert into audit_log ${columns} values ${placeholders}`, params);
}

function toEntry(row) {
  return {
    id: Number(row.id),
    occurredAt: isoOrNull(row.occurred_at),
    actor: {
      id: row.actor_user_id,
      username: row.actor_username,
      role: row.actor_role,
      ip: row.actor_ip,
      sessionId: row.actor_session_id
    },
    event: row.event,
    outcome: row.outcome,
    target: { type: row.target_type, id: row.target_id, label: row.target_label },
    detail: jsonObject(row.detail)
  };
}

/** Most recent first. Filters are all optional and all indexed. */
async function search(db, { event = null, actorUserId = null, targetId = null, limit = 100, before = null } = {}) {
  const where = [];
  const params = [];
  if (event) { where.push("event = ?"); params.push(event); }
  if (actorUserId) { where.push("actor_user_id = ?"); params.push(actorUserId); }
  if (targetId) { where.push("target_id = ?"); params.push(targetId); }
  if (before) { where.push("id < ?"); params.push(before); }

  const rows = await db.many(
    `select * from audit_log
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by id desc limit ?`,
    [...params, Math.min(Number(limit) || 100, 1000)]
  );
  return rows.map(toEntry);
}

/**
 * Deletes in bounded batches. A single unbounded DELETE over a year of rows
 * would hold locks long enough to stall every write in the application.
 */
async function deleteOlderThan(db, cutoff, events = null, batchSize = 5000) {
  let removed = 0;
  for (;;) {
    const params = [cutoff];
    let sql = "delete from audit_log where occurred_at < ?";
    if (events && events.length) {
      sql += ` and event in (${events.map(() => "?").join(", ")})`;
      params.push(...events);
    }
    sql += " limit ?";
    params.push(batchSize);

    const result = await db.run(sql, params);
    removed += result.affectedRows;
    if (result.affectedRows < batchSize) break;
  }
  return removed;
}

module.exports = { insert, insertMany, search, deleteOlderThan, toEntry };
