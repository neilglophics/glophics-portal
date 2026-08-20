/**
 * Sync watermarks: when Jira was last polled, when it was last swept in full,
 * and what went wrong if anything did.
 *
 * A single row, created by migration 006.
 */

const { isoOrNull, toDate } = require("../db/columns.js");

async function get(db) {
  const row = await db.one(
    `select last_jira_sync_at, last_full_sweep_at, last_jira_error
       from sync_state where id = 1`
  );
  if (!row) throw new Error("sync_state row is missing; migration 006 did not run.");
  return {
    lastJiraSyncAt: isoOrNull(row.last_jira_sync_at),
    lastFullSweepAt: isoOrNull(row.last_full_sweep_at),
    lastJiraError: row.last_jira_error
  };
}

async function update(db, patch) {
  const sets = ["updated_at = current_timestamp(3)"];
  const params = [];
  if (patch.lastJiraSyncAt !== undefined) {
    sets.push("last_jira_sync_at = ?");
    params.push(toDate(patch.lastJiraSyncAt));
  }
  if (patch.lastFullSweepAt !== undefined) {
    sets.push("last_full_sweep_at = ?");
    params.push(toDate(patch.lastFullSweepAt));
  }
  if (patch.lastJiraError !== undefined) {
    sets.push("last_jira_error = ?");
    params.push(patch.lastJiraError ?? null);
  }
  if (params.length) {
    await db.run(`update sync_state set ${sets.join(", ")} where id = 1`, params);
  }
  return get(db);
}

module.exports = { get, update };
