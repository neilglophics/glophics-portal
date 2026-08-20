/**
 * Jira-derived data: issues the sync knows about but which are not holding an
 * environment, and issues it could not place at all.
 *
 * The point of this file is that an idle sync writes nothing. Each row carries
 * a hash of its own content; the sync asks for the current hashes, compares in
 * memory, and writes only what differs. That turns "poll Jira every twenty
 * seconds" from a full table rewrite plus a broadcast to every open tab into,
 * usually, two SELECTs and silence.
 *
 * MySQL has no INSERT ... RETURNING, so the changed set is computed here rather
 * than reported by the database. Doing it this way also keeps the code working
 * on MySQL 8, where MariaDB's RETURNING extension does not exist.
 */

const crypto = require("node:crypto");
const { jsonArray, toJson, isoOrNull, toDate } = require("../db/columns.js");

/**
 * A stable fingerprint of everything the browser would see.
 *
 * Arrays are sorted before hashing: the matcher's output order is incidental,
 * and an unsorted hash would report a change every time it happened to come
 * back the other way round.
 *
 * `syncRunId` and `seenAt` are deliberately excluded -- they change on every
 * pass by definition, and including them would make the whole mechanism inert.
 */
function contentHash(issue) {
  const canonical = JSON.stringify([
    issue.key,
    issue.serverId ?? null,
    issue.accountName ?? null,
    issue.branch ?? null,
    [...(issue.repos || [])].sort(),
    [...(issue.userIds || [])].sort(),
    [...(issue.rawAssignees || [])].sort(),
    issue.status ?? "",
    issue.summary ?? null,
    issue.startTime ?? null,
    issue.endTime ?? null
  ]);
  return crypto.createHash("sha256").update(canonical).digest();
}

function skippedHash(entry) {
  const canonical = JSON.stringify([
    entry.key, entry.reason ?? "", entry.status ?? null,
    entry.accountName ?? null, entry.branch ?? null
  ]);
  return crypto.createHash("sha256").update(canonical).digest();
}

function toIssue(row) {
  return {
    key: row.key,
    serverId: row.server_id,
    accountName: row.account_name,
    branch: row.branch,
    repos: jsonArray(row.repos),
    userIds: jsonArray(row.user_ids),
    rawAssignees: jsonArray(row.raw_assignees),
    status: row.status,
    summary: row.summary,
    startTime: isoOrNull(row.start_time),
    endTime: isoOrNull(row.end_time)
  };
}

function toSkipped(row) {
  return {
    key: row.key,
    reason: row.reason,
    status: row.status,
    accountName: row.account_name,
    branch: row.branch
  };
}

const ISSUE_COLUMNS = `
  \`key\`, server_id, account_name, branch, repos, user_ids, raw_assignees,
  status, summary, start_time, end_time
`;

async function listIssues(db) {
  const rows = await db.many(`select ${ISSUE_COLUMNS} from jira_issues order by \`key\``);
  return rows.map(toIssue);
}

async function listSkipped(db) {
  const rows = await db.many(
    "select `key`, reason, status, account_name, branch from jira_skipped order by `key`"
  );
  return rows.map(toSkipped);
}

async function findIssuesByKeys(db, keys) {
  if (!keys.length) return [];
  const rows = await db.many(
    `select ${ISSUE_COLUMNS} from jira_issues where \`key\` in (${keys.map(() => "?").join(", ")})`,
    keys
  );
  return rows.map(toIssue);
}

async function findSkippedByKeys(db, keys) {
  if (!keys.length) return [];
  const rows = await db.many(
    `select \`key\`, reason, status, account_name, branch from jira_skipped
      where \`key\` in (${keys.map(() => "?").join(", ")})`,
    keys
  );
  return rows.map(toSkipped);
}

/** key -> content hash (hex), for the whole table. The change-detection input. */
async function issueHashes(db) {
  const map = new Map();
  for (const row of await db.many("select `key`, content_hash from jira_issues")) {
    map.set(row.key, row.content_hash.toString("hex"));
  }
  return map;
}

async function skippedHashes(db) {
  const map = new Map();
  for (const row of await db.many("select `key`, content_hash from jira_skipped")) {
    map.set(row.key, row.content_hash.toString("hex"));
  }
  return map;
}

/**
 * Writes the issues whose hash differs from what is stored, and returns their
 * keys. An issue whose content is unchanged is not touched at all.
 */
async function upsertIssues(db, issues, syncRunId, existingHashes) {
  const changed = [];
  for (const issue of issues) {
    const hash = contentHash(issue);
    const hex = hash.toString("hex");
    if (existingHashes.get(issue.key) === hex) continue;

    await db.run(
      `insert into jira_issues
         (\`key\`, server_id, account_name, branch, repos, user_ids, raw_assignees,
          status, summary, start_time, end_time, content_hash, sync_run_id, seen_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp(3))
       on duplicate key update
         server_id = values(server_id), account_name = values(account_name),
         branch = values(branch), repos = values(repos), user_ids = values(user_ids),
         raw_assignees = values(raw_assignees), status = values(status),
         summary = values(summary), start_time = values(start_time),
         end_time = values(end_time), content_hash = values(content_hash),
         sync_run_id = values(sync_run_id), seen_at = current_timestamp(3)`,
      [
        issue.key, issue.serverId ?? null, issue.accountName ?? null, issue.branch ?? null,
        toJson(issue.repos || []), toJson(issue.userIds || []), toJson(issue.rawAssignees || []),
        issue.status ?? "", issue.summary ?? null,
        toDate(issue.startTime), toDate(issue.endTime),
        hash, syncRunId
      ]
    );
    changed.push(issue.key);
  }
  return changed;
}

async function upsertSkipped(db, entries, syncRunId, existingHashes) {
  const changed = [];
  for (const entry of entries) {
    const hash = skippedHash(entry);
    const hex = hash.toString("hex");
    if (existingHashes.get(entry.key) === hex) continue;

    await db.run(
      `insert into jira_skipped
         (\`key\`, reason, status, account_name, branch, content_hash, sync_run_id, seen_at)
       values (?, ?, ?, ?, ?, ?, ?, current_timestamp(3))
       on duplicate key update
         reason = values(reason), status = values(status),
         account_name = values(account_name), branch = values(branch),
         content_hash = values(content_hash), sync_run_id = values(sync_run_id),
         seen_at = current_timestamp(3)`,
      [
        entry.key, entry.reason, entry.status ?? null,
        entry.accountName ?? null, entry.branch ?? null, hash, syncRunId
      ]
    );
    changed.push(entry.key);
  }
  return changed;
}

/**
 * Marks the rows this pass did not see so the sync can decide what to do with
 * them. Only meaningful after a full sweep -- during an incremental pass most
 * rows are legitimately absent from the results, so deleting on that basis
 * would empty the table every twenty seconds.
 */
async function listStaleIssueKeys(db, syncRunId) {
  const rows = await db.many("select `key` from jira_issues where sync_run_id <> ?", [syncRunId]);
  return rows.map((row) => row.key);
}

async function listStaleSkippedKeys(db, syncRunId) {
  const rows = await db.many("select `key` from jira_skipped where sync_run_id <> ?", [syncRunId]);
  return rows.map((row) => row.key);
}

async function deleteIssues(db, keys) {
  if (!keys.length) return 0;
  const result = await db.run(
    `delete from jira_issues where \`key\` in (${keys.map(() => "?").join(", ")})`,
    keys
  );
  return result.affectedRows;
}

async function deleteSkipped(db, keys) {
  if (!keys.length) return 0;
  const result = await db.run(
    `delete from jira_skipped where \`key\` in (${keys.map(() => "?").join(", ")})`,
    keys
  );
  return result.affectedRows;
}

async function countIssues(db) {
  const row = await db.one("select count(*) as total from jira_issues");
  return Number(row.total);
}

// -------------------------------------------------------------- sync runs --

async function startRun(db, mode) {
  const result = await db.run("insert into jira_sync_runs (mode) values (?)", [mode]);
  return Number(result.insertId);
}

async function finishRun(db, id, { issueCount, changedCount, skippedCount, error = null }) {
  await db.run(
    `update jira_sync_runs
        set finished_at = current_timestamp(3), issue_count = ?, changed_count = ?,
            skipped_count = ?, error = ?
      where id = ?`,
    [issueCount ?? null, changedCount ?? null, skippedCount ?? null, error, id]
  );
}

module.exports = {
  contentHash, skippedHash, toIssue, toSkipped,
  listIssues, listSkipped, findIssuesByKeys, findSkippedByKeys,
  issueHashes, skippedHashes, upsertIssues, upsertSkipped,
  listStaleIssueKeys, listStaleSkippedKeys, deleteIssues, deleteSkipped,
  countIssues, startRun, finishRun
};
