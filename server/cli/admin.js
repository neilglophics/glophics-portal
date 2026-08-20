#!/usr/bin/env node
/**
 * Operator commands that do not go through the web UI.
 *
 *   node server/cli/admin.js list
 *   node server/cli/admin.js create-admin <username> [--password <pw>]
 *   node server/cli/admin.js set-password <username>          (reads the new password from stdin)
 *   node server/cli/admin.js unlock <username>
 *   node server/cli/admin.js revoke-sessions <username>
 *   node server/cli/admin.js rotate-secret-key
 *
 * `set-password` reads from stdin rather than argv deliberately -- a password
 * passed as a command-line argument sits in shell history and in `ps` output
 * for every user on the box for as long as the process runs. The previous
 * CLI took it as an argument; this is the one thing here that is not a
 * straight port of that behaviour.
 *
 * There is no `reset` command. The one it replaces set the password back to
 * the published literal "admin1234" -- the single worst line in the file it
 * came from. Use `set-password` and a real password instead.
 */

const readline = require("node:readline");
const crypto = require("node:crypto");

const { assertValid, config } = require("../config.js");
const { db, tx, close } = require("../db/client.js");
const authUsers = require("../repositories/auth-users.repo.js");
const sessionsRepo = require("../repositories/auth-sessions.repo.js");
const passwords = require("../security/passwords.js");
const policy = require("../services/password-policy.js");
const throttle = require("../services/throttle.service.js");
const secrets = require("../services/secrets.service.js");
const audit = require("../services/audit.service.js");

function readSecretFromStdin(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(`${prompt}: `);
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function list() {
  const rows = await authUsers.list(db);
  if (!rows.length) {
    console.log("No sign-in accounts exist yet.");
    return;
  }
  for (const row of rows) {
    const user = authUsers.toPublicUser(row);
    const flags = [
      user.active ? null : "inactive",
      user.mustChangePassword ? "must-change-password" : null
    ].filter(Boolean).join(", ");
    console.log(`${user.username.padEnd(20)} ${user.role.padEnd(12)} ${user.active ? "active  " : "inactive"} ${flags}`);
  }
}

async function createAdmin(username, explicitPassword) {
  if (!username) throw new Error("Usage: create-admin <username> [--password <pw>]");
  const normalized = username.trim().toLowerCase();

  const existing = await authUsers.findByUsername(db, normalized);
  if (existing) throw new Error(`"${normalized}" already has a login.`);

  const password = explicitPassword || crypto.randomBytes(18).toString("base64url");
  const errors = policy.check(password, { username: normalized });
  if (errors.length) throw new Error(`Password does not meet policy:\n  - ${errors.join("\n  - ")}`);

  const hash = await passwords.hash(password);
  const id = crypto.randomUUID();

  await tx(async (t) => {
    await authUsers.insert(t, {
      id, username: normalized, displayName: "Admin", role: "superadmin",
      passwordHash: hash, mustChangePassword: true, active: true
    });
    await audit.record(t, audit.EVENTS.ADMIN_SEEDED, null, {
      target: { type: "user", id, label: normalized },
      detail: { role: "superadmin", source: "cli" }
    });
  });

  console.log(`Created superadmin "${normalized}".`);
  if (!explicitPassword) console.log(`Password: ${password}  (not shown again — write it down)`);
  console.log("They will be asked to set a new password on first sign-in.");
}

async function setPassword(username) {
  if (!username) throw new Error("Usage: set-password <username>");
  const row = await authUsers.findByUsername(db, username);
  if (!row) throw new Error(`No account named "${username}".`);

  const password = await readSecretFromStdin("New password");
  const errors = policy.check(password, { username: row.username, displayName: row.display_name });
  if (errors.length) throw new Error(`Password does not meet policy:\n  - ${errors.join("\n  - ")}`);

  const hash = await passwords.hash(password);
  await tx(async (t) => {
    await authUsers.setPassword(t, row.id, hash, { mustChangePassword: true });
    await sessionsRepo.revokeAllForUser(t, row.id, "cli-set-password");
    await audit.record(t, audit.EVENTS.PASSWORD_RESET, null, {
      target: { type: "user", id: row.id, label: row.username },
      detail: { source: "cli" }
    });
  });
  console.log(`Password set for "${row.username}". Every existing session was revoked.`);
}

async function unlock(username) {
  if (!username) throw new Error("Usage: unlock <username>");
  await throttle.unlock(username);
  console.log(`Sign-in throttle cleared for "${username}".`);
}

async function revokeSessions(username) {
  if (!username) throw new Error("Usage: revoke-sessions <username>");
  const row = await authUsers.findByUsername(db, username);
  if (!row) throw new Error(`No account named "${username}".`);
  const revoked = await sessionsRepo.revokeAllForUser(db, row.id, "cli");
  console.log(`Revoked ${revoked.length} session(s) for "${row.username}".`);
}

async function rotateSecretKey() {
  if (!config.previousSecretKey) {
    console.log(
      "Set APP_SECRET_KEY to the NEW key and APP_SECRET_KEY_PREVIOUS to the current one, then re-run this."
    );
    return;
  }
  const result = await secrets.reencryptAll(null);
  console.log(`Re-encrypted ${result.count} secret(s) under the new key.`);
  console.log("You may now drop APP_SECRET_KEY_PREVIOUS from the environment.");
}

async function main() {
  assertValid();
  const [, , command, ...rest] = process.argv;
  const flagIndex = rest.indexOf("--password");
  const explicitPassword = flagIndex >= 0 ? rest[flagIndex + 1] : null;
  const args = flagIndex >= 0 ? rest.slice(0, flagIndex) : rest;

  switch (command) {
    case "list": await list(); break;
    case "create-admin": await createAdmin(args[0], explicitPassword); break;
    case "set-password": await setPassword(args[0]); break;
    case "unlock": await unlock(args[0]); break;
    case "revoke-sessions": await revokeSessions(args[0]); break;
    case "rotate-secret-key": await rotateSecretKey(); break;
    default:
      console.log([
        "Usage:",
        "  node server/cli/admin.js list",
        "  node server/cli/admin.js create-admin <username> [--password <pw>]",
        "  node server/cli/admin.js set-password <username>",
        "  node server/cli/admin.js unlock <username>",
        "  node server/cli/admin.js revoke-sessions <username>",
        "  node server/cli/admin.js rotate-secret-key"
      ].join("\n"));
      process.exitCode = command ? 2 : 0;
  }
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => close());
