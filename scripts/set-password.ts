/**
 * Set an account's password from outside the app.
 *
 *   npm run auth:set-password -- <username> <password>
 *   npm run auth:list
 *
 * This is the port of the legacy `node server/auth-store.js set-password`, and it
 * exists for the same reason that one did: the case it covers is a forgotten
 * password, where the app itself is no help because signing in is exactly what
 * you cannot do.
 *
 * Note what it deliberately is NOT: ADMIN_PASSWORD is not a way in. That variable
 * only seeds the *first* account when auth_users is empty — once any account
 * exists it is ignored, because an env var that can overwrite a live password
 * would be a permanent backdoor into every deployment that sets it.
 *
 * Setting a password here also drops that user's sessions and clears their
 * failed-attempt counter. Clearing the counter matters: without it you can set a
 * fresh password and still be locked out for ten minutes, which reads as the new
 * password not having worked.
 */

import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();

const MIN_PASSWORD_LENGTH = 8;

function usage(): never {
  console.log("usage:");
  console.log("  npm run auth:list");
  console.log("  npm run auth:set-password -- <username> <password>");
  console.log("  npm run auth:unlock -- <username>          (or with no name, everyone)");
  process.exit(1);
}

async function main() {
  const sql = neon(requireEnv("DATABASE_URL"));
  const [command, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const users = (await sql`
      SELECT u.username, u.role, u.active, u.last_login_at, d.name AS person,
             a.fail_count, a.locked_until
        FROM auth_users u
        LEFT JOIN directory_users d ON d.id = u.directory_user_id
        LEFT JOIN auth_login_attempts a ON a.username = u.username
       ORDER BY u.username
    `) as {
      username: string;
      role: string;
      active: boolean;
      last_login_at: string | null;
      person: string | null;
      fail_count: number | null;
      locked_until: string | null;
    }[];

    if (!users.length) {
      console.log("No accounts. Set ADMIN_USERNAME/ADMIN_PASSWORD and sign in once to seed one.");
      return;
    }

    for (const u of users) {
      const lockedFor = u.locked_until
        ? Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000)
        : 0;

      const bits = [
        u.username.padEnd(16),
        u.role.padEnd(11),
        u.active ? "active" : "DEACTIVATED",
        u.person ? `→ ${u.person}` : "→ (not linked to anyone on the board)",
      ];
      if (u.fail_count) bits.push(`${u.fail_count} failed attempt(s)`);
      if (lockedFor > 0) bits.push(`LOCKED for ${lockedFor} more minute(s)`);

      console.log(`  ${bits.join("  ")}`);
    }
    return;
  }

  /**
   * Clears the failed-attempt counter.
   *
   * The lockout is the app's only brute-force defence, so it is deliberately not
   * something the UI can waive — but locking out the one super admin who could
   * fix anything is a corner nobody should have to wait ten minutes out of. This
   * is the same escape hatch set-password is: reachable when the app itself
   * cannot help, because signing in is exactly what you cannot do.
   */
  if (command === "unlock") {
    const name = rest[0] ? rest[0].trim().toLowerCase() : null;

    const cleared = (await (name
      ? sql`DELETE FROM auth_login_attempts WHERE username = ${name} RETURNING username`
      : sql`DELETE FROM auth_login_attempts RETURNING username`)) as { username: string }[];

    if (!cleared.length) {
      console.log(name ? `"${name}" was not locked.` : "Nobody was locked.");
      return;
    }
    console.log(`Cleared: ${cleared.map((r) => r.username).join(", ")}`);
    console.log("Those accounts can try again immediately.");
    return;
  }

  if (command !== "set-password") usage();

  const [usernameArg, password] = rest;
  if (!usernameArg || !password) usage();

  const username = usernameArg.trim().toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  const found = (await sql`SELECT id FROM auth_users WHERE username = ${username}`) as { id: string }[];
  if (!found[0]) {
    console.error(`No account called "${username}". Try: npm run auth:list`);
    process.exit(1);
  }

  // Same scrypt parameters as lib/auth/password.ts. Kept in step by hand rather
  // than imported, because importing that module would pull in the whole
  // Next.js path-alias resolution for a two-line hash.
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");

  await sql`
    UPDATE auth_users SET salt = ${salt}, hash = ${hash}, updated_at = now()
     WHERE id = ${found[0].id}
  `;
  await sql`DELETE FROM auth_sessions WHERE user_id = ${found[0].id}`;
  await sql`DELETE FROM auth_login_attempts WHERE username = ${username}`;

  console.log(`Password set for ${username}.`);
  console.log("Any session it had is signed out, and its lockout counter is cleared.");
}

main().catch((err: Error) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
