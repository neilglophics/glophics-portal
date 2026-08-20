/**
 * Password hashing. Ported from the legacy server/auth-store.js — same scrypt
 * parameters, so hashes carried over by the import script keep verifying.
 *
 * scrypt with a per-user random salt, compared with a timing-safe equal. No
 * dependencies: everything here is node:crypto, which is why every module that
 * imports this must run on the Node runtime, not Edge.
 */

import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 8;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function hashWithSalt(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
}

export function newCredentials(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashWithSalt(password, salt) };
}

export function passwordMatches(
  stored: { salt: string | null; hash: string | null },
  password: string,
): boolean {
  if (!stored.salt || !stored.hash) return false;

  const attempt = Buffer.from(hashWithSalt(password, stored.salt), "hex");
  const expected = Buffer.from(stored.hash, "hex");

  // timingSafeEqual throws on a length mismatch, so check first. Lengths are
  // fixed by SCRYPT_KEYLEN, so this only differs for a malformed stored hash.
  if (attempt.length !== expected.length) return false;
  return crypto.timingSafeEqual(attempt, expected);
}

export function normalizeUsername(username: unknown): string {
  return String(username ?? "").trim().toLowerCase();
}

/** A session token, and the form of it that goes in the database.
 *
 *  Only the hash is stored: a read-only leak of auth_sessions must not hand
 *  anyone a working session. The legacy app kept live tokens in plaintext next
 *  to the password hashes, so this is a deliberate improvement, not a port. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
