-- Delivery means the browser rendered the alert. Reading is a separate user
-- action: a toast can arrive while somebody is busy and still belong in their
-- notification centre as unread.

ALTER TABLE jira_notifications
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Alerts delivered before this feature existed were already surfaced to the
-- user. Treating them as unread would create a misleading backlog on deploy.
UPDATE jira_notifications
   SET read_at = delivered_at
 WHERE read_at IS NULL
   AND delivered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS jira_notifications_history_idx
  ON jira_notifications (auth_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS jira_notifications_unread_idx
  ON jira_notifications (auth_user_id, created_at DESC)
  WHERE read_at IS NULL;
