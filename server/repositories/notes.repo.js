/**
 * Free-text notes pinned to one repository of one environment.
 *
 * The browser sees a flat map keyed "<serverId>::<repoName>". That separator was
 * a workaround for JSON objects having only string keys; in the database the
 * pair is the primary key, and the key is only re-assembled in the board
 * projection. Nothing else in the server ever splits a string on "::".
 */

async function list(db) {
  return db.many("select server_id, repo_name, body from repo_notes order by server_id, repo_name");
}

/** The flat map the browser expects. Assembled here and nowhere else. */
async function asMap(db) {
  const map = {};
  for (const row of await list(db)) {
    map[`${row.server_id}::${row.repo_name}`] = row.body;
  }
  return map;
}

async function find(db, serverId, repoName) {
  const row = await db.one(
    "select body from repo_notes where server_id = ? and repo_name = ?",
    [serverId, repoName]
  );
  return row ? row.body : null;
}

/**
 * Writes a note, or removes it when the text is blank.
 *
 * Blank meaning "delete" is the existing behaviour -- clearing the textarea in
 * the UI removes the note rather than storing an empty one -- and it is what
 * keeps the projection free of empty strings the UI would render as a note.
 */
async function set(db, serverId, repoName, body, actorId = null) {
  const text = String(body ?? "").trim();
  if (!text) {
    const result = await db.run(
      "delete from repo_notes where server_id = ? and repo_name = ?",
      [serverId, repoName]
    );
    return { removed: result.affectedRows > 0, body: null };
  }
  await db.run(
    `insert into repo_notes (server_id, repo_name, body, updated_by)
     values (?, ?, ?, ?)
     on duplicate key update
       body = values(body),
       updated_by = values(updated_by),
       updated_at = current_timestamp(3)`,
    [serverId, repoName, text, actorId]
  );
  return { removed: false, body: text };
}

module.exports = { list, asMap, find, set };
