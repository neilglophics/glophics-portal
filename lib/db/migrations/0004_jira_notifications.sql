-- Jira alerts are stored locally. Realtime only signals that this authenticated
-- user should fetch them, so ticket details never cross the realtime provider.

CREATE TABLE IF NOT EXISTS jira_notifications (
  id            bigserial   PRIMARY KEY,
  auth_user_id  uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('assigned', 'status-changed', 'conflict')),
  ticket_id     text        NOT NULL,
  title         text        NOT NULL,
  body          text        NOT NULL,
  href          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS jira_notifications_pending_idx
  ON jira_notifications (auth_user_id, created_at)
  WHERE delivered_at IS NULL;
