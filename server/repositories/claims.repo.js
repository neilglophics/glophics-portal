/**
 * Claims -- what the UI calls "tickets": a hold on one or more repositories of
 * one environment.
 *
 * `repos` and `userIds` are join tables because they are queried ("which claims
 * hold this repo", "which claims belong to this person"); `rawAssignees` is a
 * JSON column because it is opaque Jira text that is only ever read back whole.
 */

const { jsonArray, toJson, isoOrNull, toDate } = require("../db/columns.js");

const SELECT = `
  select id, source, server_id, account_name, branch, status, summary, note,
         raw_assignees, start_time, end_time, claimed_at, last_synced_at
    from claims
`;

function toClaim(row, repos = [], userIds = []) {
  return {
    id: row.id,
    source: row.source,
    serverId: row.server_id,
    accountName: row.account_name,
    branch: row.branch,
    repos,
    userIds,
    rawAssignees: jsonArray(row.raw_assignees),
    status: row.status,
    summary: row.summary,
    note: row.note,
    startTime: isoOrNull(row.start_time),
    endTime: isoOrNull(row.end_time),
    claimedAt: isoOrNull(row.claimed_at),
    lastSyncedAt: isoOrNull(row.last_synced_at)
  };
}

async function childrenFor(db, claimIds) {
  if (claimIds === null) {
    return {
      repos: await groupChild(db, "select claim_id, repo_name as value from claim_repos order by claim_id, position, repo_name"),
      users: await groupChild(db, "select claim_id, user_id as value from claim_users order by claim_id, position, user_id")
    };
  }
  if (!claimIds.length) return { repos: new Map(), users: new Map() };
  const placeholders = claimIds.map(() => "?").join(", ");
  return {
    repos: await groupChild(
      db,
      `select claim_id, repo_name as value from claim_repos where claim_id in (${placeholders}) order by claim_id, position, repo_name`,
      claimIds
    ),
    users: await groupChild(
      db,
      `select claim_id, user_id as value from claim_users where claim_id in (${placeholders}) order by claim_id, position, user_id`,
      claimIds
    )
  };
}

async function groupChild(db, sql, params = []) {
  const grouped = new Map();
  for (const row of await db.many(sql, params)) {
    if (!grouped.has(row.claim_id)) grouped.set(row.claim_id, []);
    grouped.get(row.claim_id).push(row.value);
  }
  return grouped;
}

async function hydrate(db, rows) {
  if (!rows.length) return [];
  const { repos, users } = await childrenFor(db, rows.map((r) => r.id));
  return rows.map((row) => toClaim(row, repos.get(row.id) || [], users.get(row.id) || []));
}

async function list(db) {
  const rows = await db.many(`${SELECT} order by claimed_at, id`);
  if (!rows.length) return [];
  const { repos, users } = await childrenFor(db, null);
  return rows.map((row) => toClaim(row, repos.get(row.id) || [], users.get(row.id) || []));
}

async function findById(db, id) {
  const row = await db.one(`${SELECT} where id = ?`, [id]);
  if (!row) return null;
  return (await hydrate(db, [row]))[0];
}

async function listByServer(db, serverId) {
  return hydrate(db, await db.many(`${SELECT} where server_id = ? order by claimed_at, id`, [serverId]));
}

async function exists(db, id) {
  const row = await db.one("select 1 as present from claims where id = ?", [id]);
  return Boolean(row);
}

/** Jira keys currently holding an environment -- the sync asks for these by name. */
async function listJiraKeysHeld(db) {
  const rows = await db.many("select id from claims where source = 'jira' order by id");
  return rows.map((row) => row.id);
}

async function insert(db, claim) {
  await db.run(
    `insert into claims
       (id, source, server_id, account_name, branch, status, summary, note,
        raw_assignees, start_time, end_time, claimed_at, last_synced_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claim.id, claim.source, claim.serverId, claim.accountName || "", claim.branch || "",
      claim.status || "", claim.summary ?? null, claim.note ?? null,
      toJson(claim.rawAssignees || []),
      toDate(claim.startTime), toDate(claim.endTime),
      toDate(claim.claimedAt) || new Date(), toDate(claim.lastSyncedAt)
    ]
  );
  await setRepos(db, claim.id, claim.repos || []);
  await setUsers(db, claim.id, claim.userIds || []);
}

async function setRepos(db, claimId, repoNames) {
  await db.run("delete from claim_repos where claim_id = ?", [claimId]);
  let position = 0;
  for (const repoName of repoNames) {
    await db.run(
      "insert into claim_repos (claim_id, repo_name, position) values (?, ?, ?)",
      [claimId, repoName, position]
    );
    position += 1;
  }
}

async function setUsers(db, claimId, userIds) {
  await db.run("delete from claim_users where claim_id = ?", [claimId]);
  let position = 0;
  for (const userId of userIds) {
    await db.run(
      "insert into claim_users (claim_id, user_id, position) values (?, ?, ?)",
      [claimId, userId, position]
    );
    position += 1;
  }
}

async function updateNote(db, id, note) {
  const result = await db.run(
    "update claims set note = ?, updated_at = current_timestamp(3) where id = ?",
    [note ?? null, id]
  );
  return result.affectedRows > 0;
}

/**
 * The Jira sync's per-pass write for a claim it already knows about.
 *
 * `lastSyncedAt` moves on every pass and nothing renders it, so it is written
 * unconditionally but is deliberately not part of the "did anything change"
 * answer -- otherwise every poll would look like a change and rebroadcast.
 */
async function touchFromJira(db, id, { status, summary }) {
  const before = await db.one("select status, summary from claims where id = ?", [id]);
  if (!before) return { changed: false };
  const changed = before.status !== status || (before.summary ?? null) !== (summary ?? null);
  await db.run(
    `update claims
        set status = ?, summary = ?, last_synced_at = current_timestamp(3),
            updated_at = current_timestamp(3)
      where id = ?`,
    [status ?? "", summary ?? null, id]
  );
  return { changed };
}

async function remove(db, id) {
  const result = await db.run("delete from claims where id = ?", [id]);
  return result.affectedRows > 0;
}

async function removeMany(db, ids) {
  if (!ids.length) return 0;
  const result = await db.run(
    `delete from claims where id in (${ids.map(() => "?").join(", ")})`,
    ids
  );
  return result.affectedRows;
}

async function listIdsByServer(db, serverId) {
  const rows = await db.many("select id from claims where server_id = ?", [serverId]);
  return rows.map((row) => row.id);
}

/** Claims whose booked time has run out. Used by the expiry job. */
async function listExpired(db, now = new Date()) {
  return hydrate(db, await db.many(
    `${SELECT} where end_time is not null and end_time <= ? order by end_time`,
    [now]
  ));
}

/** Renames the denormalised account name after an account is renamed. */
async function renameAccount(db, serverIds, accountName) {
  if (!serverIds.length) return [];
  const placeholders = serverIds.map(() => "?").join(", ");
  const rows = await db.many(
    `select id from claims where server_id in (${placeholders}) and account_name <> ?`,
    [...serverIds, accountName]
  );
  if (!rows.length) return [];
  await db.run(
    `update claims set account_name = ?, updated_at = current_timestamp(3)
      where server_id in (${placeholders}) and account_name <> ?`,
    [accountName, ...serverIds, accountName]
  );
  return rows.map((row) => row.id);
}

/**
 * Drops repositories that no longer exist from every claim on these servers,
 * then reports the claims left holding nothing -- which the service deletes.
 */
async function dropRepos(db, serverIds, repoNames) {
  if (!serverIds.length || !repoNames.length) return { touched: [], emptied: [] };
  const serverPlaceholders = serverIds.map(() => "?").join(", ");
  const repoPlaceholders = repoNames.map(() => "?").join(", ");

  const touched = await db.many(
    `select distinct r.claim_id
       from claim_repos r
       join claims c on c.id = r.claim_id
      where c.server_id in (${serverPlaceholders}) and r.repo_name in (${repoPlaceholders})`,
    [...serverIds, ...repoNames]
  );
  if (!touched.length) return { touched: [], emptied: [] };

  await db.run(
    `delete r from claim_repos r
       join claims c on c.id = r.claim_id
      where c.server_id in (${serverPlaceholders}) and r.repo_name in (${repoPlaceholders})`,
    [...serverIds, ...repoNames]
  );

  const ids = touched.map((row) => row.claim_id);
  const emptied = await db.many(
    `select c.id from claims c
      where c.id in (${ids.map(() => "?").join(", ")})
        and not exists (select 1 from claim_repos r where r.claim_id = c.id)`,
    ids
  );
  return { touched: ids, emptied: emptied.map((row) => row.id) };
}

module.exports = {
  toClaim, hydrate, list, findById, listByServer, exists, listJiraKeysHeld,
  insert, setRepos, setUsers, updateNote, touchFromJira, remove, removeMany,
  listIdsByServer, listExpired, renameAccount, dropRepos
};
