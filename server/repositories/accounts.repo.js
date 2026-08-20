/**
 * Accounts, and the repository names each one owns.
 *
 * An account's id is editable in the UI -- renaming "singaprinting" changes the
 * primary key. Every foreign key pointing here is declared ON UPDATE CASCADE so
 * that is one statement rather than a hand-written ripple; the parts that
 * cannot cascade (claims store the account's *display name*, not its id) are
 * the service's job.
 */

const SELECT = "select id, display_name, position from accounts";

function toAccount(row, repositories = []) {
  return { id: row.id, displayName: row.display_name, repositories };
}

/** accountId -> [repoName], ordered. One query regardless of account count. */
async function repositoriesByAccount(db, accountIds = null) {
  let sql = "select account_id, repo_name from account_repositories";
  const params = [];
  if (accountIds) {
    if (!accountIds.length) return new Map();
    sql += ` where account_id in (${accountIds.map(() => "?").join(", ")})`;
    params.push(...accountIds);
  }
  sql += " order by account_id, position, repo_name";

  const grouped = new Map();
  for (const row of await db.many(sql, params)) {
    if (!grouped.has(row.account_id)) grouped.set(row.account_id, []);
    grouped.get(row.account_id).push(row.repo_name);
  }
  return grouped;
}

async function list(db) {
  const rows = await db.many(`${SELECT} order by position, display_name`);
  const repos = await repositoriesByAccount(db);
  return rows.map((row) => toAccount(row, repos.get(row.id) || []));
}

async function findById(db, id) {
  const row = await db.one(`${SELECT} where id = ?`, [id]);
  if (!row) return null;
  const repos = await repositoriesByAccount(db, [id]);
  return toAccount(row, repos.get(id) || []);
}

async function findByDisplayName(db, displayName) {
  const row = await db.one(`${SELECT} where display_name_key = lower(trim(?))`, [displayName]);
  if (!row) return null;
  const repos = await repositoriesByAccount(db, [row.id]);
  return toAccount(row, repos.get(row.id) || []);
}

async function exists(db, id) {
  const row = await db.one("select 1 as present from accounts where id = ?", [id]);
  return Boolean(row);
}

async function nextPosition(db) {
  const row = await db.one("select coalesce(max(position), -1) + 1 as next from accounts");
  return Number(row.next);
}

async function insert(db, { id, displayName, position }) {
  await db.run(
    "insert into accounts (id, display_name, position) values (?, ?, ?)",
    [id, displayName, position]
  );
}

async function update(db, id, { newId, displayName }) {
  await db.run(
    `update accounts
        set id = coalesce(?, id),
            display_name = coalesce(?, display_name),
            updated_at = current_timestamp(3)
      where id = ?`,
    [newId ?? null, displayName ?? null, id]
  );
}

async function remove(db, id) {
  const result = await db.run("delete from accounts where id = ?", [id]);
  return result.affectedRows > 0;
}

async function setRepositories(db, accountId, repoNames) {
  await db.run("delete from account_repositories where account_id = ?", [accountId]);
  let position = 0;
  for (const repoName of repoNames) {
    await db.run(
      "insert into account_repositories (account_id, repo_name, position) values (?, ?, ?)",
      [accountId, repoName, position]
    );
    position += 1;
  }
}

module.exports = {
  toAccount, repositoriesByAccount, list, findById, findByDisplayName,
  exists, nextPosition, insert, update, remove, setRepositories
};
