-- 0001_init — the whole schema from docs/02-DATA-MODEL.md.
--
-- Order is dependency order: directory_users before auth_users (which links to
-- it), accounts before servers, claims before their join tables.
--
-- Forward-only. Never edit an applied migration; add another.

-- gen_random_uuid() is built in from Postgres 13, so no pgcrypto needed.

-- ============================================================
-- The people directory: assignable to a claim, not necessarily
-- able to sign in. Most of this table has no login.
-- ============================================================

CREATE TABLE directory_users (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  job_role   text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX directory_users_name_key ON directory_users (lower(btrim(name)));

-- The labels Jira may write in a ticket's "Ticket Assignee" field for this
-- person. One person can answer to several. A label must be globally unique or
-- matching becomes a coin toss, which is why the constraint is here and not
-- only in application code.
CREATE TABLE directory_user_jira_names (
  directory_user_id text NOT NULL REFERENCES directory_users(id) ON DELETE CASCADE,
  jira_name         text NOT NULL,
  PRIMARY KEY (directory_user_id, jira_name)
);

CREATE UNIQUE INDEX directory_jira_name_global_key
  ON directory_user_jira_names (lower(btrim(jira_name)));

-- ============================================================
-- Auth: who can sign in
-- ============================================================

CREATE TABLE auth_users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username          text        NOT NULL,
  display_name      text        NOT NULL,
  role              text        NOT NULL,
  directory_user_id text        REFERENCES directory_users(id) ON DELETE SET NULL,
  salt              text        NOT NULL,
  hash              text        NOT NULL,
  active            boolean     NOT NULL DEFAULT true,
  last_seen_at      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_users_username_lower CHECK (username = lower(username)),
  CONSTRAINT auth_users_role_valid
    CHECK (role IN ('superadmin', 'admin', 'member', 'viewer'))
);

CREATE UNIQUE INDEX auth_users_username_key ON auth_users (username);

-- One person, one login. Two logins pointing at the same directory person would
-- each be shown the other's Jira tickets as their own.
CREATE UNIQUE INDEX auth_users_directory_user_key
  ON auth_users (directory_user_id) WHERE directory_user_id IS NOT NULL;

-- SHA-256 of the session token, never the token itself: a read-only leak of
-- this table must not hand anyone a working session.
CREATE TABLE auth_sessions (
  token_hash text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip         inet
);

CREATE INDEX auth_sessions_user_idx    ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

-- The login lockout counter, which was in-process memory in the legacy app and
-- cannot survive a stateless platform.
CREATE TABLE auth_login_attempts (
  username     text        PRIMARY KEY,
  fail_count   integer     NOT NULL DEFAULT 0,
  locked_until timestamptz
);

-- ============================================================
-- The board
-- ============================================================

CREATE TABLE accounts (
  id           text        PRIMARY KEY,
  display_name text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- display_name is what Jira's "Account Name" field is matched against,
-- case-insensitively, so it has to be unique that way.
CREATE UNIQUE INDEX accounts_display_name_key ON accounts (lower(btrim(display_name)));

CREATE TABLE account_repositories (
  account_id text    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  repo_name  text    NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, repo_name)
);

CREATE TABLE servers (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  account_id text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One account cannot have two environments of the same name: that pair is what
-- a Jira ticket is matched on, so a duplicate makes matching ambiguous.
CREATE UNIQUE INDEX servers_account_name_key ON servers (account_id, lower(btrim(name)));

-- Per-repo URL, health, and note. The note lived in its own notes.json keyed by
-- "serverId::repoName" — which is exactly this primary key, so the separate
-- table earned nothing.
CREATE TABLE server_repos (
  server_id         text        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  repo_name         text        NOT NULL,
  url               text        NOT NULL DEFAULT '',
  health            text        NOT NULL DEFAULT 'unconfigured',
  health_checked_at timestamptz,
  note              text,
  PRIMARY KEY (server_id, repo_name),

  CONSTRAINT server_repos_health_valid
    CHECK (health IN ('online', 'offline', 'checking', 'unconfigured'))
);

-- Live occupancy. "Claim", not "ticket": a Jira ticket is a thing in Jira, a
-- claim is a thing on this board, and the same key can be both or neither.
CREATE TABLE claims (
  id             text        PRIMARY KEY,
  source         text        NOT NULL,
  server_id      text        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  account_name   text,
  branch         text,
  status         text        NOT NULL,
  summary        text,
  note           text,
  start_time     timestamptz,
  end_time       timestamptz,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,

  CONSTRAINT claims_source_valid CHECK (source IN ('jira', 'manual')),
  CONSTRAINT claims_time_order
    CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time)
);

CREATE INDEX claims_server_idx   ON claims (server_id);
CREATE INDEX claims_end_time_idx ON claims (end_time) WHERE end_time IS NOT NULL;

CREATE TABLE claim_repos (
  claim_id  text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  repo_name text NOT NULL,
  PRIMARY KEY (claim_id, repo_name)
);

CREATE INDEX claim_repos_repo_idx ON claim_repos (repo_name);

CREATE TABLE claim_assignees (
  claim_id          text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  directory_user_id text NOT NULL REFERENCES directory_users(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, directory_user_id)
);

-- Jira labels that matched nobody, kept verbatim so the board can show
-- "assigned to a name we don't know" instead of silently showing nobody.
CREATE TABLE claim_raw_assignees (
  claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  label    text NOT NULL,
  PRIMARY KEY (claim_id, label)
);

-- Exactly one row. The CHECK makes a second impossible rather than unlikely.
CREATE TABLE settings (
  id                    integer     PRIMARY KEY DEFAULT 1,
  default_booking_hours integer     NOT NULL DEFAULT 4,
  on_expiry             text        NOT NULL DEFAULT 'remind',
  assign_whole_env      boolean     NOT NULL DEFAULT true,
  jira                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settings_single_row CHECK (id = 1),
  CONSTRAINT settings_on_expiry_valid
    CHECK (on_expiry IN ('remind', 'remind-flag', 'auto-release'))
);

-- ============================================================
-- Jira-derived cache. Rebuilt from scratch by every sync pass.
-- NOT a source of truth: never read these for occupancy — `claims` is.
-- Array columns are acceptable here for exactly that reason.
-- ============================================================

CREATE TABLE jira_issues (
  key           text        PRIMARY KEY,
  server_id     text        REFERENCES servers(id) ON DELETE SET NULL,
  account_name  text,
  branch        text,
  status        text,
  summary       text,
  start_time    timestamptz,
  end_time      timestamptz,
  repos         text[]      NOT NULL DEFAULT '{}',
  user_ids      text[]      NOT NULL DEFAULT '{}',
  raw_assignees text[]      NOT NULL DEFAULT '{}',
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jira_issues_server_idx ON jira_issues (server_id);
CREATE INDEX jira_issues_status_idx ON jira_issues (status);

CREATE TABLE jira_skipped (
  key          text        PRIMARY KEY,
  reason       text        NOT NULL,
  status       text,
  account_name text,
  branch       text,
  synced_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jira_sync_state (
  id           integer PRIMARY KEY DEFAULT 1,
  last_sync_at timestamptz,
  last_error   text,
  CONSTRAINT jira_sync_state_single_row CHECK (id = 1)
);

-- ============================================================
-- Chat
--
-- Participants are auth_users (people who can sign in), NOT directory_users.
-- You can only usefully chat with someone who can read it. See ADR-007 and
-- docs/06-OPEN-QUESTIONS.md Q4 — this is the assumption to revisit first if
-- the product decision comes back differently.
-- ============================================================

CREATE TABLE chat_conversations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL,
  title           text,
  -- For a DM: the two auth_users ids sorted and joined, so a second DM between
  -- the same pair is refused by the database rather than by a racy check.
  dm_key          text,
  -- Reserved for per-environment channels (docs/06-OPEN-QUESTIONS.md Q9).
  -- Nullable and unused for now; adding it costs nothing and keeps the door open.
  server_id       text        REFERENCES servers(id) ON DELETE SET NULL,
  created_by      uuid        REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,

  CONSTRAINT chat_conversations_kind_valid CHECK (kind IN ('dm', 'group')),
  CONSTRAINT chat_conversations_dm_key_shape CHECK (
    (kind = 'dm'    AND dm_key IS NOT NULL AND title IS NULL) OR
    (kind = 'group' AND dm_key IS NULL)
  )
);

CREATE UNIQUE INDEX chat_conversations_dm_key_uniq
  ON chat_conversations (dm_key) WHERE dm_key IS NOT NULL;

CREATE INDEX chat_conversations_recent_idx
  ON chat_conversations (last_message_at DESC NULLS LAST);

-- THE authorization boundary for chat. Every read, every write, and
-- /api/pusher/auth all check this table.
CREATE TABLE chat_members (
  conversation_id      uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id              uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  member_role          text        NOT NULL DEFAULT 'member',
  joined_at            timestamptz NOT NULL DEFAULT now(),
  -- Read state is a WATERMARK, not a row per message: O(members), not
  -- O(messages × members). See ADR-006.
  last_read_message_id bigint,
  last_read_at         timestamptz,
  muted                boolean     NOT NULL DEFAULT false,

  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT chat_members_role_valid CHECK (member_role IN ('owner', 'member'))
);

-- "My conversations" — the hottest chat query there is.
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

CREATE TABLE chat_messages (
  -- bigserial deliberately: this is the ordering key AND the pagination cursor.
  -- Never order chat by a client-supplied timestamp; clocks disagree.
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: removing someone's login must not delete their side
  -- of every conversation. A null sender renders as a former member.
  sender_id       uuid        REFERENCES auth_users(id) ON DELETE SET NULL,
  -- Generated by the browser before sending, so a retry after a dropped
  -- response is idempotent and the composer can reconcile its optimistic row.
  client_msg_id   text        NOT NULL,
  body            text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'text',
  reply_to_id     bigint      REFERENCES chat_messages(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT chat_messages_kind_valid CHECK (kind IN ('text', 'system', 'attachment')),
  CONSTRAINT chat_messages_body_len   CHECK (length(body) <= 8000)
);

-- The INSERT uses ON CONFLICT DO NOTHING against this.
CREATE UNIQUE INDEX chat_messages_client_id_uniq
  ON chat_messages (conversation_id, client_msg_id);

-- Keyset pagination: WHERE conversation_id = $1 AND id < $cursor ORDER BY id DESC
CREATE INDEX chat_messages_conv_id_idx ON chat_messages (conversation_id, id DESC);

CREATE TABLE chat_attachments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    bigint      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  blob_url      text        NOT NULL,
  -- Needed to delete the blob later. Without it, deleted messages leave
  -- billable orphans behind.
  blob_pathname text        NOT NULL,
  filename      text        NOT NULL,
  mime          text        NOT NULL,
  bytes         bigint      NOT NULL,
  width         integer,
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_attachments_bytes_positive CHECK (bytes > 0)
);

CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);

-- ============================================================
-- Derived occupancy, as a view.
--
-- The authoritative implementation is lib/shared/occupancy.ts; this mirrors it
-- for bulk queries and must be kept in step with it, not the other way round.
-- ============================================================

CREATE VIEW server_occupancy AS
SELECT
  s.id AS server_id,
  CASE
    WHEN bool_or(sr.health = 'offline')                              THEN 'issue'
    WHEN count(cr.repo_name) = 0                                     THEN 'free'
    WHEN count(DISTINCT cr.repo_name) = count(DISTINCT sr.repo_name) THEN 'inuse'
    ELSE 'partial'
  END AS status
FROM servers s
JOIN server_repos sr ON sr.server_id = s.id
LEFT JOIN claims c ON c.server_id = s.id
LEFT JOIN claim_repos cr ON cr.claim_id = c.id AND cr.repo_name = sr.repo_name
GROUP BY s.id;
