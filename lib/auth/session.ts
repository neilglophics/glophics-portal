/**
 * Sessions. Opaque random tokens, stored as SHA-256 hashes in Postgres.
 *
 * Deliberately not JWTs — see ADR-004 in docs/05-DECISIONS.md. The app's
 * documented behaviour is that changing a password, changing a role, or
 * deactivating an account ends every session that person holds *immediately*.
 * A stateless token cannot be revoked before it expires without a denylist,
 * which is this table with extra steps.
 *
 * Node runtime only: it reaches node:crypto through ./password.
 */

import { cookies } from "next/headers";
import { sql } from "@/lib/db/client";
import { hashToken, newSessionToken } from "./password";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./constants";
import { userJiraNames } from "@/lib/jira/matching";
import type { AuthUser, RoleId } from "@/lib/types";

// Re-exported so existing importers keep working; defined in ./constants because
// middleware needs the cookie name and cannot import anything Node-only.
export { SESSION_COOKIE, SESSION_TTL_MS };

/**
 * `Secure` is set, unlike the legacy app — that server spoke plain HTTP on a
 * LAN and its comment said so explicitly. Vercel is HTTPS, so the reason for
 * omitting it is gone. In local development over http://localhost, browsers
 * treat localhost as a secure context, so this still works.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

interface SessionRow {
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

function toAuthUser(row: SessionRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    // A link whose person has since been removed reads as unlinked rather than
    // as an error: the account still signs in, it just has no Jira names.
    directoryUserId: row.directory_user_id,
    // Read *through* the link, never stored on the account — so fixing a typo
    // in the directory fixes what "My tickets" shows, with no second edit.
    jiraNames: row.directory_name
      ? userJiraNames({ name: row.directory_name, jiraNames: row.jira_names ?? [] })
      : [],
    active: row.active,
    lastSeenAt: row.last_seen_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/**
 * Resolves a raw token to the user behind it, or null.
 *
 * Checks `expires_at` here rather than trusting the retention sweep to have run,
 * and refuses a deactivated account so revoking access does not wait out the
 * session's own expiry.
 */
export async function resolveSession(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token) return null;

  const rows = (await sql`
    SELECT u.id, u.username, u.display_name, u.role, u.directory_user_id,
           u.active, u.last_seen_at, u.last_login_at, u.created_at,
           d.name AS directory_name,
           COALESCE(
             array_agg(n.jira_name) FILTER (WHERE n.jira_name IS NOT NULL),
             '{}'
           ) AS jira_names
      FROM auth_sessions s
      JOIN auth_users u ON u.id = s.user_id
      LEFT JOIN directory_users d ON d.id = u.directory_user_id
      LEFT JOIN directory_user_jira_names n ON n.directory_user_id = d.id
     WHERE s.token_hash = ${hashToken(token)}
       AND s.expires_at > now()
       AND u.active = true
     GROUP BY u.id, d.name
  `) as SessionRow[];

  const row = rows[0];
  return row ? toAuthUser(row) : null;
}

/** The signed-in user for the current request, from the cookie. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

/** Mints a session and sets the cookie. Caller has already verified the password. */
export async function createSession(userId: string, meta?: { userAgent?: string; ip?: string }) {
  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await sql`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at, user_agent, ip)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()},
            ${meta?.userAgent ?? null}, ${meta?.ip ?? null})
  `;
  await sql`UPDATE auth_users SET last_login_at = now() WHERE id = ${userId}`;

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(Math.floor(SESSION_TTL_MS / 1000)));

  return { token, expiresAt };
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) {
    await sql`DELETE FROM auth_sessions WHERE token_hash = ${hashToken(token)}`;
  }
  jar.set(SESSION_COOKIE, "", cookieOptions(0));
}

/**
 * Every session belonging to one user, dropped at once.
 *
 * Used when their password changes, their role changes, or they are deactivated,
 * so an already-open tab cannot keep the access it just lost. This is the
 * mechanism behind the app's instant-revocation guarantee — do not weaken it.
 *
 * Once Pusher is wired (Phase 7), this should also publish `session.revoked` on
 * `private-user-<id>` so the open tab finds out now rather than on its next
 * request. See docs/03-REALTIME-SPEC.md §4.
 */
export async function revokeSessionsFor(userId: string): Promise<void> {
  await sql`DELETE FROM auth_sessions WHERE user_id = ${userId}`;
}

/** Retention: drop expired rows. Called by the retention cron. */
export async function pruneExpiredSessions(): Promise<number> {
  const rows = (await sql`
    DELETE FROM auth_sessions WHERE expires_at <= now() RETURNING token_hash
  `) as unknown[];
  return rows.length;
}
