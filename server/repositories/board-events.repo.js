/**
 * The realtime event log.
 *
 * Appending here is what gives each SSE frame a monotone sequence number, which
 * is what lets a browser notice it missed one. Without that, a dropped frame is
 * invisible and the tab drifts quietly out of date -- the failure mode that
 * makes people distrust a live view.
 */

const { toJson, jsonObject } = require("../db/columns.js");

async function append(db, type, payload, origin = null) {
  const result = await db.run(
    "insert into board_events (type, payload, origin) values (?, ?, ?)",
    [type, toJson(payload ?? {}), origin]
  );
  return Number(result.insertId);
}

/** Events after `seq`, for a tab resuming a dropped stream. */
async function since(db, seq, limit = 500) {
  const rows = await db.many(
    "select seq, type, payload, origin from board_events where seq > ? order by seq limit ?",
    [seq, limit]
  );
  return rows.map((row) => ({
    seq: Number(row.seq),
    type: row.type,
    payload: jsonObject(row.payload),
    origin: row.origin
  }));
}

async function latestSeq(db) {
  const row = await db.one("select coalesce(max(seq), 0) as seq from board_events");
  return Number(row.seq);
}

/** The oldest sequence still retained. A tab asking for anything older than
 *  this cannot be caught up incrementally and must refetch the board. */
async function oldestSeq(db) {
  const row = await db.one("select coalesce(min(seq), 0) as seq from board_events");
  return Number(row.seq);
}

async function prune(db, olderThanMs) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await db.run("delete from board_events where created_at < ?", [cutoff]);
  return result.affectedRows;
}

module.exports = { append, since, latestSeq, oldestSeq, prune };
