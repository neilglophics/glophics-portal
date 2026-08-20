/**
 * Credential storage and the sign-in handshake.
 *
 * Ported from server/auth-store.js. Three things changed, all deliberate:
 *
 *   - Sessions store a SHA-256 of the token, not the token (lib/auth/session.ts).
 *   - The lockout counter is a table, not process memory — a stateless platform
 *     has nowhere to keep it, and it is the app's only brute-force defence.
 *   - Validation returns an error list rather than throwing, matching the legacy
 *     `{ ok, errors }` shape the forms already know how to render.
 */

import { sql, isUniqueViolation, withTransaction } from "@/lib/db/client";
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN, newCredentials, normalizeUsername, passwordMatches } from "@/lib/auth/password";
import { isValidRole } from "@/lib/shared/roles";
import { userJiraNames } from "@/lib/jira/matching";
import type { AuthUser, RoleId } from "@/lib/types";

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS = 10 * 60 * 1000;

export const DEFAULT_ADMIN_USERNAME = "admin";

// ---------- shapes ----------

interface AuthUserRow {
  id: string;
  username: string;
  display_name: string;
  role: RoleId;
  directory_user_id: string | null;
  active: boolean;
  last_seen_at: string | null;
  last_login_at: string | null;
  created_at: string | null;
  directory_name: string | null;
  jira_names: string[] | null;
}

/** The only user shape that ever leaves the server. No salt, no hash. */
function toPublicUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    directoryUserId: row.directory_user_id,
    jiraNames: row.directory_name
      ? userJiraNames({ name: row.directory_name, jiraNames: row.jira_names ?? [] })
      : [],
    active: row.active,
    lastSeenAt: row.last_seen_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function listAuthUsers(): Promise<AuthUser[]> {
  const rows = (await sql`
    SELECT u.id, u.username, u.display_name, u.role, u.directory_user_id,
           u.active, u.last_seen_at, u.last_login_at, u.created_at,
           d.name AS directory_name,
           COALESCE(array_agg(n.jira_name) FILTER (WHERE n.jira_name IS NOT NULL), '{}') AS jira_names
      FROM auth_users u
      LEFT JOIN directory_users d ON d.id = u.directory_user_id
      LEFT JOIN directory_user_jira_names n ON n.directory_user_id = d.id
     GROUP BY u.id, d.name
     ORDER BY u.username
  `) as AuthUserRow[];

  return rows.map(toPublicUser);
}

export async function getAuthUser(id: string): Promise<AuthUser | null> {
  const rows = (await sql`
    SELECT u.id, u.username, u.display_name, u.role, u.directory_user_id,
           u.active, u.last_seen_at, u.last_login_at, u.created_at,
           d.name AS directory_name,
           COALESCE(array_agg(n.jira_name) FILTER (WHERE n.jira_name IS NOT NULL), '{}') AS jira_names
      FROM auth_users u
      LEFT JOIN directory_users d ON d.id = u.directory_user_id
      LEFT JOIN directory_user_jira_names n ON n.directory_user_id = d.id
     WHERE u.id = ${id}
     GROUP BY u.id, d.name
  `) as AuthUserRow[];

  const row = rows[0];
  return row ? toPublicUser(row) : null;
}

// ---------- lockout ----------

async function lockoutRemainingMs(username: string): Promise<number> {
  const rows = (await sql`
    SELECT locked_until FROM auth_login_attempts WHERE username = ${username}
  `) as { locked_until: string | null }[];

  const until = rows[0]?.locked_until;
  if (!until) return 0;
  return Math.max(0, new Date(until).getTime() - Date.now());
}

async function recordFailure(username: string): Promise<void> {
  // One statement so two simultaneous wrong guesses cannot both read 7 and
  // write 8, which is how a lockout threshold quietly becomes advisory.
  await sql`
    INSERT INTO auth_login_attempts (username, fail_count, locked_until)
    VALUES (${username}, 1, NULL)
    ON CONFLICT (username) DO UPDATE
      SET fail_count = auth_login_attempts.fail_count + 1,
          locked_until = CASE
            WHEN auth_login_attempts.fail_count + 1 >= ${LOCKOUT_THRESHOLD}
            THEN now() + ${`${LOCKOUT_MS} milliseconds`}::interval
            ELSE NULL
          END
  `;
}

async function clearFailures(username: string): Promise<void> {
  await sql`DELETE FROM auth_login_attempts WHERE username = ${username}`;
}

// ---------- sign in ----------

export type SignInResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

export async function verifySignIn(usernameInput: unknown, password: unknown): Promise<SignInResult> {
  const username = normalizeUsername(usernameInput);

  const lockedFor = await lockoutRemainingMs(username);
  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60000);
    return { ok: false, error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const rows = (await sql`
    SELECT id, salt, hash, active FROM auth_users WHERE username = ${username}
  `) as { id: string; salt: string; hash: string; active: boolean }[];

  const user = rows[0];

  // One message covers both "no such user" and "wrong password" — separate ones
  // would tell an attacker which usernames exist.
  if (!user || !passwordMatches(user, String(password ?? ""))) {
    await recordFailure(username);
    return { ok: false, error: "That username and password don't match." };
  }
  if (!user.active) {
    return { ok: false, error: "That account has been deactivated. Ask a super admin to re-enable it." };
  }

  await clearFailures(username);
  return { ok: true, userId: user.id };
}

// ---------- validation ----------

interface CredentialInput {
  username?: unknown;
  displayName?: unknown;
  role?: unknown;
  password?: unknown;
  directoryUserId?: unknown;
}

function normalizeLink(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id || null;
}

async function validate(input: CredentialInput, existingId: string | null): Promise<string[]> {
  const errors: string[] = [];
  const username = normalizeUsername(input.username);

  if (!username) {
    errors.push("Username is required.");
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.push(
      "Username must be 3-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.",
    );
  } else {
    const taken = (await sql`
      SELECT 1 FROM auth_users
       WHERE username = ${username} AND (${existingId}::uuid IS NULL OR id <> ${existingId}::uuid)
       LIMIT 1
    `) as unknown[];
    if (taken.length) errors.push(`The username "${username}" is already taken.`);
  }

  if (!String(input.displayName ?? "").trim()) errors.push("Display name is required.");
  if (!isValidRole(input.role)) errors.push("Pick a role.");

  if (input.password !== undefined && String(input.password).length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // One person, one account. Two logins pointing at the same directory person
  // would each be shown the other's tickets as their own, so the clash is
  // refused here rather than discovered at sync time. (The database enforces it
  // too — this is for a readable message.)
  const link = normalizeLink(input.directoryUserId);
  if (link) {
    const exists = (await sql`SELECT 1 FROM directory_users WHERE id = ${link} LIMIT 1`) as unknown[];
    if (!exists.length) errors.push("That person is not in the directory any more — pick somebody else.");

    const owner = (await sql`
      SELECT username FROM auth_users
       WHERE directory_user_id = ${link} AND (${existingId}::uuid IS NULL OR id <> ${existingId}::uuid)
       LIMIT 1
    `) as { username: string }[];
    if (owner[0]) errors.push(`That person already signs in as @${owner[0].username}.`);
  }

  return errors;
}

/** Guards the one state nobody can recover from through the UI: no super admin
 *  left to hand the role back out. */
async function isLastActiveSuperAdmin(userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM auth_users
     WHERE id <> ${userId} AND role = 'superadmin' AND active = true
     LIMIT 1
  `) as unknown[];
  return rows.length === 0;
}

// ---------- mutations ----------

export type MutationResult = { ok: true; user?: AuthUser } | { ok: false; errors: string[] };

export async function createAuthUser(input: CredentialInput): Promise<MutationResult> {
  const errors = await validate({ ...input, password: input.password ?? "" }, null);
  if (errors.length) return { ok: false, errors };

  const { salt, hash } = newCredentials(String(input.password));

  try {
    const rows = (await sql`
      INSERT INTO auth_users (username, display_name, role, directory_user_id, salt, hash)
      VALUES (${normalizeUsername(input.username)}, ${String(input.displayName).trim()},
              ${input.role as string}, ${normalizeLink(input.directoryUserId)}, ${salt}, ${hash})
      RETURNING id
    `) as { id: string }[];

    const created = await getAuthUser(rows[0]!.id);
    return { ok: true, ...(created ? { user: created } : {}) };
  } catch (err) {
    // The unique indexes are the real arbiter; validate() above only produces a
    // friendlier message when it wins the race.
    if (isUniqueViolation(err)) {
      return { ok: false, errors: ["That username or person already has a login."] };
    }
    throw err;
  }
}

export async function updateAuthUser(
  userId: string,
  input: CredentialInput & { active?: unknown },
  actingUserId: string,
): Promise<MutationResult> {
  const existing = (await sql`
    SELECT id, role, active FROM auth_users WHERE id = ${userId}
  `) as { id: string; role: RoleId; active: boolean }[];

  const current = existing[0];
  if (!current) return { ok: false, errors: ["That user no longer exists."] };

  const nextRole = (input.role ?? current.role) as RoleId;
  const nextActive = input.active === undefined ? current.active : !!input.active;

  const errors = await validate({ ...input, role: nextRole, password: undefined }, userId);
  if (errors.length) return { ok: false, errors };

  const losingSuperAdmin = current.role === "superadmin" && (nextRole !== "superadmin" || !nextActive);
  if (losingSuperAdmin && (await isLastActiveSuperAdmin(userId))) {
    return { ok: false, errors: ["This is the only active super admin — promote someone else first."] };
  }
  if (userId === actingUserId && !nextActive) {
    return { ok: false, errors: ["You can't deactivate your own account."] };
  }

  // A role change or a deactivation has to take effect now, not whenever their
  // open tab happens to reload.
  const privilegeChanged = nextRole !== current.role || nextActive !== current.active;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE auth_users
          SET username = $2, display_name = $3, role = $4,
              directory_user_id = $5, active = $6, updated_at = now()
        WHERE id = $1`,
      [
        userId,
        normalizeUsername(input.username),
        String(input.displayName).trim(),
        nextRole,
        normalizeLink(input.directoryUserId),
        nextActive,
      ],
    );
    if (privilegeChanged) {
      await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
    }
  });

  const updated = await getAuthUser(userId);
  return { ok: true, ...(updated ? { user: updated } : {}) };
}

export async function deleteAuthUser(userId: string, actingUserId: string): Promise<MutationResult> {
  if (userId === actingUserId) return { ok: false, errors: ["You can't remove your own account."] };

  const rows = (await sql`SELECT role FROM auth_users WHERE id = ${userId}`) as { role: RoleId }[];
  const found = rows[0];
  if (!found) return { ok: false, errors: ["That user no longer exists."] };

  if (found.role === "superadmin" && (await isLastActiveSuperAdmin(userId))) {
    return { ok: false, errors: ["This is the only active super admin — promote someone else first."] };
  }

  // auth_sessions cascades on the foreign key, so their access ends with the row.
  await sql`DELETE FROM auth_users WHERE id = ${userId}`;
  return { ok: true };
}

/** A super admin setting someone else's password. No current password is asked
 *  for — that is what makes it a reset. */
export async function setPassword(userId: string, password: unknown): Promise<MutationResult> {
  if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
    return { ok: false, errors: [`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`] };
  }

  const { salt, hash } = newCredentials(String(password));
  const rows = (await sql`
    UPDATE auth_users SET salt = ${salt}, hash = ${hash}, updated_at = now()
     WHERE id = ${userId} RETURNING id
  `) as { id: string }[];

  if (!rows.length) return { ok: false, errors: ["That user no longer exists."] };

  await sql`DELETE FROM auth_sessions WHERE user_id = ${userId}`;
  return { ok: true };
}

/** Anyone changing their own password, which does need the current one. */
export async function changeOwnPassword(
  userId: string,
  currentPassword: unknown,
  newPassword: unknown,
): Promise<MutationResult> {
  const rows = (await sql`
    SELECT salt, hash FROM auth_users WHERE id = ${userId}
  `) as { salt: string; hash: string }[];

  const stored = rows[0];
  if (!stored) return { ok: false, errors: ["That user no longer exists."] };
  if (!passwordMatches(stored, String(currentPassword ?? ""))) {
    return { ok: false, errors: ["Your current password isn't right."] };
  }
  if (String(newPassword ?? "").length < MIN_PASSWORD_LENGTH) {
    return { ok: false, errors: [`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`] };
  }
  return setPassword(userId, newPassword);
}

// ---------- first run ----------

/**
 * Creates the first super admin when there are no accounts at all.
 *
 * The legacy app did this at boot and printed the password. There is no boot on a
 * serverless platform, so this is called by the import script and by the login
 * route when the table is empty — and it never invents a password: without
 * ADMIN_PASSWORD set there is nowhere to print one that anybody would see.
 */
export async function seedFirstSuperAdmin(): Promise<{ username: string } | null> {
  const existing = (await sql`SELECT 1 FROM auth_users LIMIT 1`) as unknown[];
  if (existing.length) return null;

  const username = normalizeUsername(process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "No accounts exist and ADMIN_PASSWORD is not set. Set ADMIN_USERNAME/ADMIN_PASSWORD and retry — " +
        "unlike the legacy server there is no console to print a generated password to.",
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const { salt, hash } = newCredentials(password);
  await sql`
    INSERT INTO auth_users (username, display_name, role, salt, hash)
    VALUES (${username}, 'Super Admin', 'superadmin', ${salt}, ${hash})
  `;
  return { username };
}
