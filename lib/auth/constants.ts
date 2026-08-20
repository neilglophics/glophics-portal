/**
 * Edge-safe auth constants.
 *
 * This module exists so `middleware.ts` can know the cookie name without
 * importing lib/auth/session.ts, which reaches node:crypto through ./password
 * and therefore cannot be bundled for the Edge runtime at all.
 *
 * Keep this file free of imports. Anything added here runs in middleware.
 */

export const SESSION_COOKIE = "sm_session";

/** A week, then sign in again. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
