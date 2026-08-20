-- 0003_jira_activity_timestamps — Jira's own created/updated instants on claims
-- and the jira_issues cache. Powers the dashboard's "Latest Jira updates" panel
-- (New / Claimed / Updated badges) with a real timestamp instead of a guess.
--
-- Named jira_* rather than plain created_at/updated_at: claims already has
-- claimed_at (when the claim started on this board) and last_synced_at (when a
-- pass last touched it); jira_issues already has synced_at. These are a third,
-- distinct thing — when Jira itself says the ticket was created/last modified —
-- and reusing created_at/updated_at here would collide with the row-audit
-- meaning those names carry on every other table.
--
-- Nullable: a manual claim has neither, and a Jira claim synced before this
-- column existed has none until the next sync pass backfills it.
--
-- Forward-only. Never edit an applied migration; add another.

ALTER TABLE claims ADD COLUMN jira_created_at timestamptz;
ALTER TABLE claims ADD COLUMN jira_updated_at timestamptz;

ALTER TABLE jira_issues ADD COLUMN jira_created_at timestamptz;
ALTER TABLE jira_issues ADD COLUMN jira_updated_at timestamptz;
