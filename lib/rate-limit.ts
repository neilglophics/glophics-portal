/**
 * Fixed-window rate limiting, in Postgres.
 *
 * ── Why one statement ──
 *
 * The check and the increment are a single INSERT … ON CONFLICT DO UPDATE, so two
 * simultaneous requests cannot both read "9 of 10" and both write 10. A
 * read-then-write in application code would make every limit here advisory —
 * exactly the bug auth_login_attempts avoids the same way.
 *
 * ── Why fixed windows ──
 *
 * A sliding log is more accurate and costs a row per request. These limits exist
 * to stop a loop, not to meter billing, so being approximately right at one row
 * per key is the better trade. The known imprecision: a caller can burst up to
 * 2× the limit across a window boundary. For "20 messages per 10 seconds" that is
 * not worth a redesign.
 */

import { sql } from "@/lib/db/client";
import { HttpError } from "@/lib/auth/require";

export interface Limit {
  /** How many are allowed inside one window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * The limits, in one place so they can be read as a policy rather than hunted
 * through route handlers. Values from docs/03-REALTIME-SPEC.md §10.
 */
export const LIMITS = {
  /** Generous enough for a fast typist pasting a few lines, low enough to stop a loop. */
  "chat.send": { max: 20, windowSeconds: 10 },
  /** The client throttles to one per 3s already; this is the backstop for a
   *  client that does not. */
  "chat.typing": { max: 6, windowSeconds: 10 },
  "chat.read": { max: 10, windowSeconds: 10 },
  "chat.conversation.create": { max: 10, windowSeconds: 3600 },
  /** Each upload costs an optimiser round trip, so this is lower than it looks
   *  like it needs to be — it protects their service as much as ours. */
  "avatar.upload": { max: 10, windowSeconds: 600 },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export interface LimitResult {
  ok: boolean;
  /** Seconds until the current window ends. Only meaningful when ok is false. */
  retryAfter: number;
}

/**
 * Counts one use against a limit.
 *
 * The key is built here from a fixed action name and the caller's id, so a
 * user-supplied value can never become a key and let somebody sidestep a limit
 * by varying it.
 */
export async function consume(action: LimitName, userId: string): Promise<LimitResult> {
  const { max, windowSeconds } = LIMITS[action];
  const key = `${action}:${userId}`;
  const interval = `${windowSeconds} seconds`;

  const rows = (await sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      -- A window that has already elapsed restarts at 1 rather than continuing
      -- to accumulate, which is what makes this a window and not a total.
      count = CASE
        WHEN rate_limits.window_start < now() - ${interval}::interval THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start < now() - ${interval}::interval THEN now()
        ELSE rate_limits.window_start
      END
    RETURNING count, window_start
  `) as { count: number; window_start: string }[];

  const row = rows[0]!;
  if (row.count <= max) return { ok: true, retryAfter: 0 };

  const elapsed = (Date.now() - new Date(row.window_start).getTime()) / 1000;
  return { ok: false, retryAfter: Math.max(1, Math.ceil(windowSeconds - elapsed)) };
}

/** Consumes one use, or throws a 429 the route wrapper turns into a response. */
export async function requireWithinLimit(action: LimitName, userId: string): Promise<void> {
  const result = await consume(action, userId);
  if (result.ok) return;

  throw new HttpError(429, "You're doing that too fast — give it a moment.", {
    retryAfter: result.retryAfter,
  });
}
