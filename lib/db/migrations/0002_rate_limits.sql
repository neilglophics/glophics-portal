-- 0002_rate_limits — server-side rate limiting.
--
-- The app has had none of this except the login lockout, and chat introduces the
-- first endpoints where its absence is dangerous: message send, typing pings and
-- conversation creation are all cheap to call in a loop.
--
-- A table rather than memory, for the same reason auth_login_attempts is a table:
-- there is no process to hold a counter in. Fixed windows rather than a sliding
-- log — one row per key instead of one row per request, which for a limiter that
-- only needs to be approximately right is the correct trade.

CREATE TABLE rate_limits (
  -- "<action>:<userId>" — built by lib/rate-limit.ts, never by a caller.
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer     NOT NULL DEFAULT 0
);

-- Lets the retention cron drop rows for windows nobody is inside any more.
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
