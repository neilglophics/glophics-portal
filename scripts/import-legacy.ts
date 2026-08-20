/**
 * One-shot import of the legacy board into Postgres.  npm run db:import
 *
 * Reads shared-data/*.json and config/auth.json and writes them into a schema
 * created by db:migrate. This is the only place old and new storage ever touch.
 *
 * Three things worth knowing:
 *
 *   - It runs `migrateAppData()` from the legacy shared/data.js once, so an
 *     old on-disk shape is normalised on the way in. After this, that machinery
 *     is done forever: Postgres has a schema.
 *
 *   - Sessions are NOT imported. Everyone signs in again once. Importing live
 *     tokens would mean writing plaintext session tokens into the new store,
 *     which the schema deliberately moved away from (it keeps SHA-256 hashes).
 *     Password hashes ARE imported — scrypt parameters are unchanged, so every
 *     existing password keeps working.
 *
 *   - It REFUSES rather than guesses. A duplicate Jira label, a claim naming an
 *     environment that no longer exists, an account pointing at a person who
 *     isn't there — each is reported at the end rather than silently coalesced.
 *     An ambiguous Jira label is exactly the bug the unique index exists to
 *     prevent, so resolving it by hand is the point.
 *
 * Re-runnable into a clean database. It is NOT idempotent against a populated
 * one: pass --truncate to clear the board tables first.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "shared-data");
const AUTH_FILE = path.join(ROOT, "config", "auth.json");

// The legacy module, run for its migrations so old shapes normalise on the way in.
const legacy = require_(path.join(ROOT, "shared", "data.js")) as {
  migrateAppData: (board: Record<string, unknown>) => boolean;
  userJiraNames: (user: { name?: string; jiraNames?: string[] }) => string[];
};

// ---------- reading ----------

interface LegacyRepo {
  url?: string;
  health?: string;
}
interface LegacyServer {
  id: string;
  name: string;
  accountId: string;
  repos: Record<string, LegacyRepo>;
}
interface LegacyAccount {
  id: string;
  displayName: string;
  repositories: string[];
}
interface LegacyUser {
  id: string;
  name: string;
  role?: string;
  jiraNames?: string[];
}
interface LegacyClaim {
  id: string;
  source: "jira" | "manual";
  serverId: string;
  accountName?: string | null;
  branch?: string | null;
  repos: string[];
  userIds: string[];
  rawAssignees?: string[];
  status: string;
  summary?: string | null;
  note?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  claimedAt?: string | null;
  lastSyncedAt?: string | null;
}
interface LegacyAuthUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  directoryUserId?: string | null;
  salt: string;
  hash: string;
  active?: boolean;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`${path.basename(file)} could not be parsed: ${(err as Error).message}`);
  }
}

const problems: string[] = [];
const notes: string[] = [];

// ---------- writing ----------

async function importAll(client: PoolClient, truncate: boolean, resetLogins: boolean) {
  const board = {
    users: readJsonFile<LegacyUser[]>(path.join(DATA_DIR, "users.json"), []),
    accounts: readJsonFile<LegacyAccount[]>(path.join(DATA_DIR, "accounts.json"), []),
    servers: readJsonFile<LegacyServer[]>(path.join(DATA_DIR, "servers.json"), []),
    tickets: readJsonFile<LegacyClaim[]>(path.join(DATA_DIR, "tickets.json"), []),
    notes: readJsonFile<Record<string, string>>(path.join(DATA_DIR, "notes.json"), {}),
    settings: readJsonFile<Record<string, unknown>>(path.join(DATA_DIR, "settings.json"), {}),
  } as unknown as Record<string, unknown>;

  if (!Array.isArray(board.users) || !Array.isArray(board.accounts) || !Array.isArray(board.servers)) {
    throw new Error("shared-data/ is missing users, accounts or servers — nothing to import.");
  }

  // Normalise old shapes exactly as the legacy app would have on its next boot.
  if (legacy.migrateAppData(board)) {
    notes.push("Legacy board needed shape migration; applied before import.");
  }

  const users = board.users as LegacyUser[];
  const accounts = board.accounts as LegacyAccount[];
  const servers = board.servers as LegacyServer[];
  const claims = board.tickets as LegacyClaim[];
  const repoNotes = board.notes as Record<string, string>;
  const settings = board.settings as Record<string, unknown>;

  if (truncate) {
    /**
     * Clears the BOARD, and deliberately not the logins.
     *
     * Re-seeding environments and claims is a routine thing to do; losing
     * everyone's password is not. An earlier version truncated auth_users too,
     * which meant a board re-import silently restored whatever hash happened to
     * be in config/auth.json and locked out anyone whose password had been
     * changed since. Use --reset-logins for that, explicitly.
     *
     * DELETE rather than TRUNCATE, for a reason that is easy to miss:
     * TRUNCATE ... CASCADE truncates every table with a foreign key INTO the
     * named ones, so `TRUNCATE directory_users CASCADE` would take auth_users
     * with it regardless of that column being ON DELETE SET NULL. DELETE honours
     * the declared action instead — logins survive with their link nulled, and
     * the import below re-links them. These tables are small, so the cost of
     * DELETE over TRUNCATE is irrelevant.
     *
     * Order is children-before-parents, since there is no CASCADE to lean on.
     */
    await client.query(`
      DELETE FROM claim_raw_assignees;
      DELETE FROM claim_assignees;
      DELETE FROM claim_repos;
      DELETE FROM claims;
      DELETE FROM jira_issues;
      DELETE FROM jira_skipped;
      DELETE FROM jira_sync_state;
      DELETE FROM server_repos;
      DELETE FROM servers;
      DELETE FROM account_repositories;
      DELETE FROM accounts;
      DELETE FROM directory_user_jira_names;
      DELETE FROM directory_users;
      DELETE FROM settings;
    `);
    notes.push("Cleared the existing board. Logins were left alone (--reset-logins to include them).");

    if (resetLogins) {
      await client.query(`
        DELETE FROM auth_sessions;
        DELETE FROM auth_login_attempts;
        DELETE FROM auth_users;
      `);
      notes.push(
        "Also cleared logins. Every account is restored from config/auth.json with ITS ORIGINAL " +
          "password — any password changed since is gone, and everyone must sign in again.",
      );
    }
  }

  // ---- directory people ----
  let jiraNameCount = 0;
  for (const user of users) {
    await client.query(
      `INSERT INTO directory_users (id, name, job_role) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, job_role = EXCLUDED.job_role`,
      [user.id, user.name, user.role ?? ""],
    );

    for (const label of legacy.userJiraNames(user)) {
      try {
        await client.query(
          `INSERT INTO directory_user_jira_names (directory_user_id, jira_name) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [user.id, label],
        );
        jiraNameCount += 1;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          // The global unique index caught a label two people both answer to.
          // That makes ticket matching a coin toss, so it is reported, not merged.
          problems.push(
            `Jira label "${label}" on ${user.name} is already claimed by someone else — ` +
              `remove the duplicate, then re-run.`,
          );
        } else throw err;
      }
    }
  }

  // ---- accounts ----
  for (const account of accounts) {
    await client.query(
      `INSERT INTO accounts (id, display_name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [account.id, account.displayName],
    );
    for (const [index, repo] of (account.repositories ?? []).entries()) {
      await client.query(
        `INSERT INTO account_repositories (account_id, repo_name, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, repo_name) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [account.id, repo, index],
      );
    }
  }

  // ---- environments and their repos ----
  const knownAccounts = new Set(accounts.map((a) => a.id));
  let repoCount = 0;

  for (const server of servers) {
    if (!knownAccounts.has(server.accountId)) {
      problems.push(`Environment "${server.name}" names account "${server.accountId}", which is not in accounts.json — skipped.`);
      continue;
    }

    await client.query(
      `INSERT INTO servers (id, name, account_id) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, account_id = EXCLUDED.account_id`,
      [server.id, server.name, server.accountId],
    );

    for (const [repoName, repo] of Object.entries(server.repos ?? {})) {
      // notes.json was keyed by the string `serverId::repoName`, which is
      // exactly this table's primary key.
      const note = repoNotes[`${server.id}::${repoName}`] ?? null;
      // Health is not carried over: whatever a stopped process last measured is
      // no longer true, and importing it would show a stale "online" as current.
      const health = repo.url ? "checking" : "unconfigured";

      await client.query(
        `INSERT INTO server_repos (server_id, repo_name, url, health, note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (server_id, repo_name)
           DO UPDATE SET url = EXCLUDED.url, health = EXCLUDED.health, note = EXCLUDED.note`,
        [server.id, repoName, repo.url ?? "", health, note],
      );
      repoCount += 1;
    }
  }

  // ---- claims ----
  const knownServers = new Set(servers.map((s) => s.id));
  const knownPeople = new Set(users.map((u) => u.id));
  let claimCount = 0;

  for (const claim of claims) {
    if (!knownServers.has(claim.serverId)) {
      problems.push(`Claim ${claim.id} names environment "${claim.serverId}", which no longer exists — skipped.`);
      continue;
    }

    await client.query(
      `INSERT INTO claims (id, source, server_id, account_name, branch, status, summary, note,
                           start_time, end_time, claimed_at, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()), $12)
       ON CONFLICT (id) DO NOTHING`,
      [
        claim.id,
        claim.source === "jira" ? "jira" : "manual",
        claim.serverId,
        claim.accountName ?? null,
        claim.branch ?? null,
        claim.status ?? "Manual",
        claim.summary ?? null,
        claim.note ?? null,
        claim.startTime ?? null,
        claim.endTime ?? null,
        claim.claimedAt ?? null,
        claim.lastSyncedAt ?? null,
      ],
    );

    for (const repo of claim.repos ?? []) {
      await client.query(
        `INSERT INTO claim_repos (claim_id, repo_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [claim.id, repo],
      );
    }
    for (const userId of claim.userIds ?? []) {
      if (!knownPeople.has(userId)) {
        problems.push(`Claim ${claim.id} is assigned to "${userId}", who is not in users.json — assignee dropped.`);
        continue;
      }
      await client.query(
        `INSERT INTO claim_assignees (claim_id, directory_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [claim.id, userId],
      );
    }
    for (const label of claim.rawAssignees ?? []) {
      await client.query(
        `INSERT INTO claim_raw_assignees (claim_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [claim.id, label],
      );
    }
    claimCount += 1;
  }

  // ---- settings ----
  await client.query(
    `INSERT INTO settings (id, default_booking_hours, on_expiry, assign_whole_env, jira)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET default_booking_hours = EXCLUDED.default_booking_hours,
           on_expiry = EXCLUDED.on_expiry,
           assign_whole_env = EXCLUDED.assign_whole_env,
           jira = EXCLUDED.jira,
           updated_at = now()`,
    [
      Number(settings.defaultBookingHours ?? 4),
      String(settings.onExpiry ?? "remind"),
      settings.assignWholeEnv !== false,
      JSON.stringify(settings.jira ?? {}),
    ],
  );

  // ---- sign-in accounts ----
  const auth = readJsonFile<{ users?: LegacyAuthUser[] }>(AUTH_FILE, {});
  const authUsers = auth.users ?? [];
  let authCount = 0;

  for (const account of authUsers) {
    const link = account.directoryUserId?.trim() || null;
    if (link && !knownPeople.has(link)) {
      problems.push(`Login @${account.username} points at person "${link}", who is not in users.json — imported unlinked.`);
    }

    try {
      await client.query(
        `INSERT INTO auth_users (id, username, display_name, role, directory_user_id,
                                 salt, hash, active, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          account.id,
          account.username.toLowerCase(),
          account.displayName,
          account.role,
          link && knownPeople.has(link) ? link : null,
          account.salt,
          account.hash,
          account.active !== false,
          account.createdAt ?? null,
          account.lastLoginAt ?? null,
        ],
      );
      authCount += 1;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        problems.push(`Login @${account.username} clashes with an existing username or person link — skipped.`);
      } else throw err;
    }
  }

  if (!authUsers.length) {
    notes.push("config/auth.json had no accounts. Set ADMIN_USERNAME/ADMIN_PASSWORD and the first sign-in will seed a super admin.");
  }

  return {
    people: users.length,
    jiraNames: jiraNameCount,
    accounts: accounts.length,
    servers: servers.length,
    repos: repoCount,
    claims: claimCount,
    logins: authCount,
  };
}

// ---------- main ----------

async function main() {
  const truncate = process.argv.includes("--truncate");
  // Wiping logins is a separate, louder decision than re-seeding the board.
  const resetLogins = process.argv.includes("--reset-logins");
  const connectionString = requireEnv(
    "DATABASE_URL_UNPOOLED",
    "Use the DIRECT (non-pooler) Neon connection string for the import.",
  );

  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`No shared-data/ directory at ${DATA_DIR} — nothing to import.`);
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    // The whole import is one transaction: a half-imported board is worse than
    // no board, because it looks like a real one.
    await client.query("BEGIN");
    const counts = await importAll(client, truncate, resetLogins);
    await client.query("COMMIT");

    console.log("\n  Imported");
    console.log(`    people          ${counts.people}`);
    console.log(`    jira labels     ${counts.jiraNames}`);
    console.log(`    accounts        ${counts.accounts}`);
    console.log(`    environments    ${counts.servers}`);
    console.log(`    repositories    ${counts.repos}`);
    console.log(`    claims          ${counts.claims}`);
    console.log(`    logins          ${counts.logins}`);

    if (notes.length) {
      console.log("\n  Notes");
      for (const note of notes) console.log(`    · ${note}`);
    }

    if (problems.length) {
      console.log(`\n  ${problems.length} thing(s) need a human decision`);
      for (const problem of problems) console.log(`    ! ${problem}`);
      console.log("\n  Nothing was guessed at. Fix these in the legacy files and re-run with --truncate.");
      process.exitCode = 1;
    } else {
      console.log("\n  Clean import — nothing was refused.");
    }

    console.log("\n  Sessions were not imported: everyone signs in again once.\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`\nImport failed: ${err.message}\n`);
  process.exit(1);
});
