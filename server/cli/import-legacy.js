#!/usr/bin/env node
/**
 * One-shot import of the board from its previous home (JSON files on disk)
 * into this MariaDB/MySQL database. Never run at boot; run once, by hand.
 *
 * Usage:
 *   node server/cli/import-legacy.js                 dry run: parse, validate, report, write nothing
 *   node server/cli/import-legacy.js --apply          write it
 *   node server/cli/import-legacy.js --apply --force  write even if the tables are not empty
 *
 * Source resolution, first hit wins:
 *   1. shared-data/{users,accounts,servers,settings,notes,tickets}.json  (the live split store)
 *   2. shared-state.json                                                 (the legacy single file)
 *   3. shared-state.json.bak-before-import                               (present in this checkout)
 *
 * migrateAppData() from shared/data.js runs on whatever is found, unmodified
 * — it is the only code that already knows every historical shape this board
 * has ever been saved in (pre-repos servers, pre-claims bookings, the old
 * jiraWaiting key), and reimplementing it here in SQL would be the same logic
 * twice with two chances to disagree.
 *
 * config/auth.json, if present, becomes login accounts. If it is absent, no
 * logins are imported and the report says to run `node server/cli/admin.js
 * create-admin` afterwards.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { assertValid } = require("../config.js");
const { tx, close } = require("../db/client.js");
const { toDate } = require("../db/columns.js");
const passwords = require("../security/passwords.js");
const { migrateAppData } = require("../../shared/data.js");

const ROOT = path.join(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findBoard() {
  const splitDir = path.join(ROOT, "shared-data");
  const sections = ["users", "accounts", "servers", "settings", "notes", "tickets"];
  if (fs.existsSync(splitDir) && sections.every((s) => fs.existsSync(path.join(splitDir, `${s}.json`)))) {
    const board = {};
    for (const section of sections) board[section] = loadJson(path.join(splitDir, `${section}.json`));
    return { board, source: "shared-data/" };
  }

  const legacy = path.join(ROOT, "shared-state.json");
  if (fs.existsSync(legacy)) return { board: loadJson(legacy), source: "shared-state.json" };

  const backup = path.join(ROOT, "shared-state.json.bak-before-import");
  if (fs.existsSync(backup)) return { board: loadJson(backup), source: "shared-state.json.bak-before-import" };

  return null;
}

function findAuth() {
  const file = path.join(ROOT, "config", "auth.json");
  if (!fs.existsSync(file)) return null;
  return { auth: loadJson(file), source: "config/auth.json" };
}

async function tableIsEmpty(t, table) {
  const row = await t.one(`select count(*) as total from ${table}`);
  return Number(row.total) === 0;
}

async function main() {
  assertValid();

  const found = findBoard();
  if (!found) {
    console.log("No board found (checked shared-data/, shared-state.json, shared-state.json.bak-before-import).");
    console.log("Nothing to import.");
    return;
  }

  const { board, source } = found;
  console.log(`Board source: ${source}`);

  const changed = migrateAppData(board);
  if (changed) console.log("migrateAppData() upgraded the board to the current shape.");

  const authFound = findAuth();
  if (authFound) console.log(`Auth source: ${authFound.source} (${authFound.auth.users.length} account(s))`);
  else console.log("No config/auth.json found — no login accounts will be imported.");

  // ---- validation, before anything is written ----
  const report = { warnings: [], counts: {} };
  const accountIds = new Set((board.accounts || []).map((a) => a.id));
  const serverIds = new Set((board.servers || []).map((s) => s.id));
  const userIds = new Set((board.users || []).map((u) => u.id));

  (board.servers || []).forEach((s) => {
    if (s.accountId && !accountIds.has(s.accountId)) {
      report.warnings.push(`Environment "${s.name}" (${s.id}) points at missing account "${s.accountId}" — will be orphaned (account_id = NULL), matching how the app already treats a deleted account.`);
    }
  });

  const seenClaimIds = new Set();
  (board.tickets || []).forEach((t) => {
    if (seenClaimIds.has(t.id)) {
      report.warnings.push(`Duplicate claim id "${t.id}" — the second one will be skipped. The old JSON store allowed this; the database's primary key does not.`);
    }
    seenClaimIds.add(t.id);
    if (!serverIds.has(t.serverId)) {
      report.warnings.push(`Claim "${t.id}" references missing server "${t.serverId}" — will be skipped entirely (no server to attach it to).`);
    }
    (t.userIds || []).forEach((uid) => {
      if (!userIds.has(uid)) {
        report.warnings.push(`Claim "${t.id}" references missing user "${uid}" — kept as-is; the app already tolerates a claim outliving the person it names (see claim_users, not a foreign key).`);
      }
    });
  });

  Object.keys(board.notes || {}).forEach((key) => {
    const sep = key.indexOf("::");
    if (sep < 0) { report.warnings.push(`Note key "${key}" has no "::" separator — will be skipped.`); return; }
    const serverId = key.slice(0, sep);
    if (!serverIds.has(serverId)) {
      report.warnings.push(`Note "${key}" references missing server "${serverId}" — will be skipped.`);
    }
  });

  report.counts = {
    directoryUsers: (board.users || []).length,
    accounts: (board.accounts || []).length,
    servers: (board.servers || []).length,
    claims: [...new Map((board.tickets || []).map((t) => [t.id, t])).values()]
      .filter((t) => serverIds.has(t.serverId)).length,
    notes: Object.keys(board.notes || {}).length,
    authUsers: authFound ? authFound.auth.users.length : 0
  };

  console.log("\nWould import:");
  Object.entries(report.counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} warning(s):`);
    report.warnings.forEach((w) => console.log(`  - ${w}`));
  }

  if (!APPLY) {
    console.log("\nDry run only. Nothing was written. Re-run with --apply to import for real.");
    await close();
    return;
  }

  await tx(async (t) => {
    if (!FORCE) {
      const boardEmpty = await tableIsEmpty(t, "directory_users")
        && await tableIsEmpty(t, "accounts") && await tableIsEmpty(t, "servers");
      if (!boardEmpty) {
        throw new Error("The database already has board data. Re-run with --force to import anyway (this will not delete what is already there, but IDs may collide).");
      }
    }

    // ---- directory ----
    let position = 0;
    for (const user of board.users || []) {
      await t.run(
        "insert into directory_users (id, name, job_title, position) values (?, ?, ?, ?) on duplicate key update name = values(name), job_title = values(job_title)",
        [user.id, user.name, user.role || "", position]
      );
      let labelPos = 0;
      for (const label of user.jiraNames || []) {
        await t.run(
          "insert ignore into directory_user_jira_names (label_key, label, user_id, position) values (lower(trim(?)), ?, ?, ?)",
          [label, label, user.id, labelPos]
        );
        labelPos += 1;
      }
      position += 1;
    }

    // ---- accounts + repositories ----
    position = 0;
    for (const account of board.accounts || []) {
      await t.run(
        "insert into accounts (id, display_name, position) values (?, ?, ?) on duplicate key update display_name = values(display_name)",
        [account.id, account.displayName, position]
      );
      let repoPos = 0;
      for (const repoName of account.repositories || []) {
        await t.run(
          "insert ignore into account_repositories (account_id, repo_name, position) values (?, ?, ?)",
          [account.id, repoName, repoPos]
        );
        repoPos += 1;
      }
      position += 1;
    }

    // ---- servers + repos ----
    position = 0;
    for (const server of board.servers || []) {
      const accountId = server.accountId && accountIds.has(server.accountId) ? server.accountId : null;
      await t.run(
        "insert into servers (id, name, account_id, position) values (?, ?, ?, ?) on duplicate key update name = values(name), account_id = values(account_id)",
        [server.id, server.name, accountId, position]
      );
      let repoPos = 0;
      for (const [repoName, repo] of Object.entries(server.repos || {})) {
        await t.run(
          `insert into server_repos (server_id, repo_name, url, health, position)
           values (?, ?, ?, ?, ?)
           on duplicate key update url = values(url), health = values(health)`,
          [server.id, repoName, repo.url || "", repo.health || "unconfigured", repoPos]
        );
        repoPos += 1;
      }
      position += 1;
    }

    // ---- claims (deduped by id, skip missing server) ----
    const claimsById = new Map();
    for (const claim of board.tickets || []) {
      if (!claimsById.has(claim.id)) claimsById.set(claim.id, claim);
    }
    for (const claim of claimsById.values()) {
      if (!serverIds.has(claim.serverId)) continue;
      await t.run(
        `insert into claims
           (id, source, server_id, account_name, branch, status, summary, note,
            raw_assignees, start_time, end_time, claimed_at, last_synced_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on duplicate key update status = values(status)`,
        [
          claim.id, claim.source || "manual", claim.serverId,
          claim.accountName || "", claim.branch || "", claim.status || "",
          claim.summary ?? null, claim.note ?? null,
          JSON.stringify(claim.rawAssignees || []),
          toDate(claim.startTime), toDate(claim.endTime),
          toDate(claim.claimedAt) || new Date(), toDate(claim.lastSyncedAt)
        ]
      );
      let repoPos = 0;
      for (const repoName of claim.repos || []) {
        await t.run(
          "insert ignore into claim_repos (claim_id, repo_name, position) values (?, ?, ?)",
          [claim.id, repoName, repoPos]
        );
        repoPos += 1;
      }
      let userPos = 0;
      for (const userId of claim.userIds || []) {
        await t.run(
          "insert ignore into claim_users (claim_id, user_id, position) values (?, ?, ?)",
          [claim.id, userId, userPos]
        );
        userPos += 1;
      }
    }

    // ---- notes ----
    for (const [key, body] of Object.entries(board.notes || {})) {
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      const serverId = key.slice(0, sep);
      const repoName = key.slice(sep + 2);
      if (!serverIds.has(serverId) || !String(body || "").trim()) continue;
      await t.run(
        `insert into repo_notes (server_id, repo_name, body) values (?, ?, ?)
         on duplicate key update body = values(body)`,
        [serverId, repoName, String(body).trim()]
      );
    }

    // ---- settings (singleton row, update in place) ----
    if (board.settings) {
      await t.run(
        `update app_settings
            set default_booking_hours = ?, on_expiry = ?, assign_whole_env = ?, jira = ?
          where id = 1`,
        [
          board.settings.defaultBookingHours || 4,
          board.settings.onExpiry || "remind",
          board.settings.assignWholeEnv === false ? 0 : 1,
          JSON.stringify(board.settings.jira || {})
        ]
      );
    }

    // ---- auth accounts ----
    if (authFound) {
      for (const user of authFound.auth.users || []) {
        const encoded = user.salt && user.hash
          ? passwords.encodeLegacy({ salt: user.salt, hash: user.hash })
          : await passwords.hash(crypto.randomBytes(18).toString("base64url"));
        await t.run(
          `insert into auth_users
             (id, username, display_name, role, directory_user_id, password_hash,
              active, must_change_password)
           values (uuid(), ?, ?, ?, ?, ?, ?, ?)
           on duplicate key update display_name = values(display_name)`,
          [
            user.username, user.displayName || user.username, user.role || "member",
            user.directoryUserId && userIds.has(user.directoryUserId) ? user.directoryUserId : null,
            encoded, user.active === false ? 0 : 1,
            // A legacy hash is not force-rotated -- the account keeps working
            // with its existing password, exactly as it did before.
            0
          ]
        );
      }
      console.log(
        "\nSessions were NOT imported (config/auth.json stored tokens in plaintext; " +
        "carrying one forward would mean hashing an already-leaked value). Everyone signs in again."
      );
    }
  });

  console.log("\nImport complete.");
  console.log("Once you have checked the board, delete shared-data/, shared-state.json*, and config/auth.json.");
  await close();
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exitCode = 1;
});
