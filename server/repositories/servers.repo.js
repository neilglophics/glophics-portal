/**
 * Environments and the repositories deployed on each one.
 *
 * The browser sees an environment's repos as a map keyed by repo name:
 *   { backend: { url, health }, admin: { url, health } }
 * Here they are rows, so a health check writes one column of one row instead of
 * rewriting the whole map -- which is what let the previous version rebroadcast
 * the entire board every thirty seconds.
 */

const SELECT = "select id, name, account_id, position from servers";

function toServer(row, repos = {}) {
  return { id: row.id, name: row.name, accountId: row.account_id, repos };
}

/** serverId -> { repoName: {url, health} }. One query for any number of servers. */
async function reposByServer(db, serverIds = null) {
  let sql = "select server_id, repo_name, url, health from server_repos";
  const params = [];
  if (serverIds) {
    if (!serverIds.length) return new Map();
    sql += ` where server_id in (${serverIds.map(() => "?").join(", ")})`;
    params.push(...serverIds);
  }
  sql += " order by server_id, position, repo_name";

  const grouped = new Map();
  for (const row of await db.many(sql, params)) {
    if (!grouped.has(row.server_id)) grouped.set(row.server_id, {});
    grouped.get(row.server_id)[row.repo_name] = { url: row.url, health: row.health };
  }
  return grouped;
}

async function list(db) {
  const rows = await db.many(`${SELECT} order by position, name`);
  const repos = await reposByServer(db);
  return rows.map((row) => toServer(row, repos.get(row.id) || {}));
}

async function findById(db, id) {
  const row = await db.one(`${SELECT} where id = ?`, [id]);
  if (!row) return null;
  const repos = await reposByServer(db, [id]);
  return toServer(row, repos.get(id) || {});
}

/**
 * The lookup the Jira sync performs for every issue: an environment named
 * `name` belonging to `accountId`, compared case-insensitively.
 */
async function findByAccountAndName(db, accountId, name) {
  const row = await db.one(
    `${SELECT} where account_id = ? and name_key = lower(trim(?))`,
    [accountId, name]
  );
  if (!row) return null;
  const repos = await reposByServer(db, [row.id]);
  return toServer(row, repos.get(row.id) || {});
}

async function exists(db, id) {
  const row = await db.one("select 1 as present from servers where id = ?", [id]);
  return Boolean(row);
}

async function nextPosition(db) {
  const row = await db.one("select coalesce(max(position), -1) + 1 as next from servers");
  return Number(row.next);
}

async function insert(db, { id, name, accountId, position }) {
  await db.run(
    "insert into servers (id, name, account_id, position) values (?, ?, ?, ?)",
    [id, name, accountId ?? null, position]
  );
}

/**
 * `accountId` is passed as a two-element tuple `[provided, value]` rather than a
 * bare value, because null is a meaningful value here (orphaning an environment)
 * and cannot be distinguished from "not changing it" any other way.
 */
async function update(db, id, { name, accountId }) {
  const sets = ["updated_at = current_timestamp(3)"];
  const params = [];
  if (name !== undefined) { sets.push("name = ?"); params.push(name); }
  if (accountId !== undefined) { sets.push("account_id = ?"); params.push(accountId); }
  params.push(id);
  await db.run(`update servers set ${sets.join(", ")} where id = ?`, params);
}

async function remove(db, id) {
  const result = await db.run("delete from servers where id = ?", [id]);
  return result.affectedRows > 0;
}

async function listIdsForAccount(db, accountId) {
  const rows = await db.many("select id from servers where account_id = ?", [accountId]);
  return rows.map((row) => row.id);
}

// ------------------------------------------------------------------- repos --

async function upsertRepo(db, serverId, repoName, { url, position }) {
  await db.run(
    `insert into server_repos (server_id, repo_name, url, position)
     values (?, ?, ?, ?)
     on duplicate key update url = values(url), position = values(position)`,
    [serverId, repoName, url ?? "", position ?? 0]
  );
}

async function removeRepo(db, serverId, repoName) {
  await db.run("delete from server_repos where server_id = ? and repo_name = ?", [serverId, repoName]);
}

/** Repo names on this environment that are not in `keep`. */
async function listRepoNames(db, serverId) {
  const rows = await db.many(
    "select repo_name from server_repos where server_id = ? order by position, repo_name",
    [serverId]
  );
  return rows.map((row) => row.repo_name);
}

async function setRepoUrl(db, serverId, repoName, url) {
  const result = await db.run(
    `update server_repos
        set url = ?,
            -- A repo with no URL cannot be checked, so clearing the URL must
            -- also clear any health verdict left over from when it had one.
            health = case when trim(?) = '' then 'unconfigured' else health end,
            checked_at = case when trim(?) = '' then null else checked_at end
      where server_id = ? and repo_name = ?`,
    [url, url, url, serverId, repoName]
  );
  return result.affectedRows > 0;
}

/** Every repo with a URL, for the health job. */
async function listCheckable(db) {
  return db.many(
    "select server_id, repo_name, url, health from server_repos where trim(url) <> '' order by server_id, repo_name"
  );
}

/**
 * Applies a batch of health verdicts and reports only the ones that actually
 * changed, so an all-green pass tells the browsers nothing at all.
 */
async function applyHealth(db, results) {
  if (!results.length) return [];
  const changed = [];
  for (const { serverId, repoName, health } of results) {
    const result = await db.run(
      `update server_repos
          set health = ?, checked_at = current_timestamp(3)
        where server_id = ? and repo_name = ? and health <> ?`,
      [health, serverId, repoName, health]
    );
    if (result.affectedRows > 0) changed.push({ serverId, repoName, health });
  }
  return changed;
}

/** Marks every repo with no URL as unconfigured, in one statement. */
async function markUnconfigured(db) {
  const result = await db.run(
    "update server_repos set health = 'unconfigured' where trim(url) = '' and health <> 'unconfigured'"
  );
  return result.affectedRows;
}

module.exports = {
  toServer, reposByServer, list, findById, findByAccountAndName, exists,
  nextPosition, insert, update, remove, listIdsForAccount,
  upsertRepo, removeRepo, listRepoNames, setRepoUrl,
  listCheckable, applyHealth, markUnconfigured
};
