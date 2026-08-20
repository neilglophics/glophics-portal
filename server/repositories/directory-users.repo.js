/**
 * Directory people: the names a claim can be attributed to.
 *
 * Repositories in this codebase take their executor as the first argument, so
 * the same function works standalone or inside a transaction:
 *
 *     await repo.findById(db, id)            // its own connection
 *     await tx((t) => repo.findById(t, id))  // inside the caller's transaction
 *
 * They contain SQL and row-to-object mapping, and nothing else -- no validation,
 * no permission checks, no events. Those belong to the service above.
 *
 * Jira labels are fetched as a second query and stitched together here rather
 * than aggregated in SQL: JSON_ARRAYAGG does not exist before MariaDB 10.5, and
 * GROUP_CONCAT would need a separator that cannot appear in a label -- a
 * guarantee nobody can make about free text somebody types into Jira.
 */

const SELECT = "select id, name, job_title, position from directory_users";

/**
 * The shape the browser has always seen. `role` here is the person's job
 * function, not an authorization role -- the column is named job_title to keep
 * the two apart internally, and mapped back on the way out so the UI is
 * unaffected.
 */
function toPerson(row, labels = []) {
  return {
    id: row.id,
    name: row.name,
    role: row.job_title,
    jiraNames: labels
  };
}

/** userId -> [label], ordered. One query regardless of how many people. */
async function labelsByUser(db, userIds = null) {
  let sql = "select user_id, label from directory_user_jira_names";
  const params = [];
  if (userIds) {
    if (!userIds.length) return new Map();
    sql += ` where user_id in (${userIds.map(() => "?").join(", ")})`;
    params.push(...userIds);
  }
  sql += " order by user_id, position, label";

  const grouped = new Map();
  for (const row of await db.many(sql, params)) {
    if (!grouped.has(row.user_id)) grouped.set(row.user_id, []);
    grouped.get(row.user_id).push(row.label);
  }
  return grouped;
}

async function list(db) {
  const rows = await db.many(`${SELECT} order by position, name`);
  const labels = await labelsByUser(db);
  return rows.map((row) => toPerson(row, labels.get(row.id) || []));
}

async function findById(db, id) {
  const row = await db.one(`${SELECT} where id = ?`, [id]);
  if (!row) return null;
  const labels = await labelsByUser(db, [id]);
  return toPerson(row, labels.get(id) || []);
}

/** Case-insensitive, matching how the application compares display names. */
async function findByName(db, name) {
  const row = await db.one(`${SELECT} where name_key = lower(trim(?))`, [name]);
  if (!row) return null;
  const labels = await labelsByUser(db, [row.id]);
  return toPerson(row, labels.get(row.id) || []);
}

async function nextPosition(db) {
  const row = await db.one("select coalesce(max(position), -1) + 1 as next from directory_users");
  return Number(row.next);
}

async function insert(db, { id, name, jobTitle, position }) {
  await db.run(
    "insert into directory_users (id, name, job_title, position) values (?, ?, ?, ?)",
    [id, name, jobTitle || "", position]
  );
}

async function update(db, id, { name, jobTitle }) {
  await db.run(
    `update directory_users
        set name = coalesce(?, name),
            job_title = coalesce(?, job_title),
            updated_at = current_timestamp(3)
      where id = ?`,
    [name ?? null, jobTitle ?? null, id]
  );
}

async function remove(db, id) {
  const result = await db.run("delete from directory_users where id = ?", [id]);
  return result.affectedRows > 0;
}

/**
 * Replaces this person's Jira labels.
 *
 * Labels are globally unique across all people, enforced by the primary key on
 * label_key. Deleting this person's rows before inserting is what lets a label
 * move from one person to another inside one transaction without tripping over
 * its own uniqueness rule.
 */
async function setJiraNames(db, userId, labels) {
  await db.run("delete from directory_user_jira_names where user_id = ?", [userId]);
  let position = 0;
  for (const label of labels) {
    await db.run(
      "insert into directory_user_jira_names (label_key, label, user_id, position) values (lower(trim(?)), ?, ?, ?)",
      [label, label, userId, position]
    );
    position += 1;
  }
}

/**
 * Who else already answers to any of these labels. Used to turn a primary-key
 * violation into a sentence naming the person, rather than a 500.
 */
async function findLabelOwners(db, labels, exceptUserId = null) {
  if (!labels.length) return [];
  const placeholders = labels.map(() => "lower(trim(?))").join(", ");
  const params = [...labels];
  let sql = `
    select n.label, n.user_id, u.name as user_name
      from directory_user_jira_names n
      join directory_users u on u.id = n.user_id
     where n.label_key in (${placeholders})`;
  if (exceptUserId) {
    sql += " and n.user_id <> ?";
    params.push(exceptUserId);
  }
  return db.many(sql, params);
}

module.exports = {
  toPerson, labelsByUser, list, findById, findByName, nextPosition,
  insert, update, remove, setJiraNames, findLabelOwners
};
