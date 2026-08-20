# 02 — Data model (Neon Postgres)

Canonical schema for the target system. The board, auth, and chat all move into Postgres; nothing
stays on local disk, because Vercel has no writable persistent disk.

> **Blocking assumption.** Chat participants are keyed on **`auth_users.id`** (people who can sign in),
> not on `directory_users.id` (people who can be assigned a claim). Rationale and the reason this must
> be confirmed before Phase 6: [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q4. If the answer changes,
> the chat tables' foreign keys change with it.

Conventions used throughout:

- `text` over `varchar(n)` — no arbitrary length limits, per Postgres guidance.
- `timestamptz` everywhere, never naive `timestamp`.
- Board ids that are **human-authored slugs or Jira keys** stay `text` (`"sticker-market"`, `"PROJ-1234"`)
  because they are load-bearing business identifiers and appear in Jira. Ids that are internal keep
  `uuid` / `bigint`.
- Forward-only numbered migrations in `lib/db/migrations/`, tracked in `schema_migrations`.
  No ORM auto-sync.

---

## 1. Auth

```sql
CREATE TABLE auth_users (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username           text        NOT NULL,
  display_name       text        NOT NULL,
  role               text        NOT NULL,
  -- Optional 1:1 link into the board's people directory. NULL is normal and
  -- expected: an account may point at nobody. See directory_users below.
  directory_user_id  text        REFERENCES directory_users(id) ON DELETE SET NULL,
  salt               text        NOT NULL,
  hash               text        NOT NULL,
  active             boolean     NOT NULL DEFAULT true,
  last_seen_at       timestamptz,          -- presence: last time a Pusher connection was seen
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_users_username_lower CHECK (username = lower(username)),
  CONSTRAINT auth_users_role_valid
    CHECK (role IN ('superadmin','admin','member','viewer'))
);

-- Usernames are normalised to lowercase before insert, so a plain unique index is enough.
CREATE UNIQUE INDEX auth_users_username_key ON auth_users (username);

-- One person, one login. Two logins pointing at the same directory person would each be
-- shown the other's Jira tickets as their own, so the clash is refused by the database.
CREATE UNIQUE INDEX auth_users_directory_user_key
  ON auth_users (directory_user_id) WHERE directory_user_id IS NOT NULL;
```

`role` is checked here **and** in `lib/shared/roles.ts`. The TypeScript list stays the single source
for *capabilities*; this CHECK only stops a garbage role reaching the table. Keep them in step — a new
role means a migration.

```sql
CREATE TABLE auth_sessions (
  -- SHA-256 of the session token, never the token itself. A read-only leak of this
  -- table must not hand anyone a working session.
  token_hash text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip         inet
);

CREATE INDEX auth_sessions_user_idx    ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);
```

Notes:

- **Storing a hash, not the token, is a change from the current system**, where `config/auth.json`
  holds live tokens in plaintext next to the password hashes. Resolving a session becomes
  `WHERE token_hash = sha256($token)`, which is still one indexed lookup.
- `ON DELETE CASCADE` gives you "removing a login drops its sessions" for free.
- `revokeSessionsFor(userId)` is `DELETE FROM auth_sessions WHERE user_id = $1`. This is the mechanism
  behind the app's documented instant-revocation behaviour — keep it.
- Expired rows are swept by the retention cron; `resolveSession` must **also** check `expires_at`
  itself and never trust the sweep to have run.

```sql
-- The login lockout counter, which is in-process memory today and cannot survive
-- a stateless platform. 8 failures then a 10-minute lock, per username.
CREATE TABLE auth_login_attempts (
  username     text        PRIMARY KEY,
  fail_count   integer     NOT NULL DEFAULT 0,
  locked_until timestamptz
);
```

---

## 2. The board

### People directory (assignable, not necessarily able to sign in)

```sql
CREATE TABLE directory_users (
  id         text        PRIMARY KEY,      -- slug: 'sem', 'jerome'
  name       text        NOT NULL,         -- display name, e.g. '[BE]_Sem'
  job_role   text        NOT NULL,         -- 'Backend', 'QA' — free text, NOT an auth role
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX directory_users_name_key ON directory_users (lower(btrim(name)));

-- The labels Jira may write in a ticket's "Ticket Assignee" field for this person.
-- One person can answer to several. A label must be globally unique, or matching
-- becomes a coin toss — which is why the constraint is here and not only in app code.
CREATE TABLE directory_user_jira_names (
  directory_user_id text NOT NULL REFERENCES directory_users(id) ON DELETE CASCADE,
  jira_name         text NOT NULL,
  PRIMARY KEY (directory_user_id, jira_name)
);

CREATE UNIQUE INDEX directory_jira_name_global_key
  ON directory_user_jira_names (lower(btrim(jira_name)));
```

`job_role` is deliberately **not** the auth role. The current system has both and they mean different
things: `directory_users.job_role` is "Backend/QA/Frontend"; `auth_users.role` is a capability set.
Conflating them would be a regression.

### Accounts and their repository slots

```sql
CREATE TABLE accounts (
  id           text        PRIMARY KEY,     -- slug: 'sticker-market'
  display_name text        NOT NULL,        -- what Jira's "Account Name" field must match
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- display_name is matched against Jira case-insensitively, so it must be unique that way.
CREATE UNIQUE INDEX accounts_display_name_key ON accounts (lower(btrim(display_name)));

CREATE TABLE account_repositories (
  account_id text    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  repo_name  text    NOT NULL,              -- 'storefront' | 'backend' | 'admin' | …
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, repo_name)
);
```

### Environments and their per-repo state

```sql
CREATE TABLE servers (
  id         text        PRIMARY KEY,        -- slug
  name       text        NOT NULL,           -- what Jira's "Branch" field must match
  account_id text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One account cannot have two environments of the same name: that pair is what a
-- Jira ticket is matched on, so a duplicate makes matching ambiguous.
CREATE UNIQUE INDEX servers_account_name_key
  ON servers (account_id, lower(btrim(name)));

CREATE TABLE server_repos (
  server_id      text        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  repo_name      text        NOT NULL,
  url            text        NOT NULL DEFAULT '',
  health         text        NOT NULL DEFAULT 'unconfigured',
  health_checked_at timestamptz,
  note           text,                       -- replaces notes.json's "serverId::repoName" key
  PRIMARY KEY (server_id, repo_name),

  CONSTRAINT server_repos_health_valid
    CHECK (health IN ('online','offline','checking','unconfigured'))
);
```

Two shape changes worth calling out:

- **`notes` folds into `server_repos.note`.** Today notes live in their own `notes.json` keyed by the
  string `` `${serverId}::${repoName}` ``. That composite key *is* `server_repos`' primary key, so the
  separate table earns nothing and the string-concatenated key can go.
- **`health_checked_at` is new** and it matters more on Vercel than it did before. With cron-driven
  checks the UI must be able to say "checked 4 minutes ago" and distinguish *offline* from
  *nobody has checked recently* — see the health blocker in
  [01-TARGET-ARCHITECTURE.md](01-TARGET-ARCHITECTURE.md) §9.

### Claims (the live occupancy)

`appData.tickets` today. Renamed to `claims` because "ticket" is overloaded: a Jira ticket is a thing
in Jira, a claim is a thing on this board, and the same key can be both, neither, or one then the other.

```sql
CREATE TABLE claims (
  -- The Jira key ('PROJ-1234') for jira-sourced claims, or a generated
  -- 'manual-…' id. Business identifier, so text and not a surrogate.
  id             text        PRIMARY KEY,
  source         text        NOT NULL,
  server_id      text        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- Denormalised copies of what Jira said, kept because they are what the ticket
  -- was matched ON and are worth preserving if the environment is later renamed.
  account_name   text,
  branch         text,

  status         text        NOT NULL,
  summary        text,
  note           text,
  start_time     timestamptz,
  end_time       timestamptz,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,

  CONSTRAINT claims_source_valid CHECK (source IN ('jira','manual')),
  CONSTRAINT claims_time_order   CHECK (end_time IS NULL OR start_time IS NULL
                                        OR end_time > start_time)
);

CREATE INDEX claims_server_idx   ON claims (server_id);
CREATE INDEX claims_end_time_idx ON claims (end_time) WHERE end_time IS NOT NULL;

-- Which repositories of that environment this claim actually holds. A claim holding
-- no rows here holds nothing and should not exist — enforced in app code, since a
-- zero-row check cannot be a table constraint.
CREATE TABLE claim_repos (
  claim_id  text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  repo_name text NOT NULL,
  PRIMARY KEY (claim_id, repo_name)
);

CREATE INDEX claim_repos_repo_idx ON claim_repos (repo_name);

-- Resolved assignees. Matched Jira labels become directory people; labels that
-- matched nobody are kept verbatim in claim_raw_assignees so the board can show
-- "assigned to a name we don't know" instead of silently showing nobody.
CREATE TABLE claim_assignees (
  claim_id          text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  directory_user_id text NOT NULL REFERENCES directory_users(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, directory_user_id)
);

CREATE TABLE claim_raw_assignees (
  claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  label    text NOT NULL,
  PRIMARY KEY (claim_id, label)
);
```

**Occupancy stays derived, never stored.** Preserve this. `free` / `partial` / `inuse` / `issue` is
computed from `server_repos.health` plus the set of claimed repos, with offline outranking everything.
Implement once in `lib/shared/occupancy.ts` and, if the dashboard needs it in bulk, mirror it as a
Postgres view:

```sql
CREATE VIEW server_occupancy AS
SELECT
  s.id AS server_id,
  CASE
    WHEN bool_or(sr.health = 'offline')                             THEN 'issue'
    WHEN count(cr.repo_name) = 0                                    THEN 'free'
    WHEN count(DISTINCT cr.repo_name) = count(DISTINCT sr.repo_name) THEN 'inuse'
    ELSE 'partial'
  END AS status
FROM servers s
JOIN server_repos sr ON sr.server_id = s.id
LEFT JOIN claims c   ON c.server_id = s.id
LEFT JOIN claim_repos cr ON cr.claim_id = c.id AND cr.repo_name = sr.repo_name
GROUP BY s.id;
```

Keep the TypeScript implementation authoritative and treat the view as an optimisation, so the two
cannot disagree about a rule as visible as "is this environment free".

### Settings

```sql
-- Exactly one row. The CHECK makes a second row impossible rather than merely unlikely.
CREATE TABLE settings (
  id                     integer PRIMARY KEY DEFAULT 1,
  default_booking_hours  integer NOT NULL DEFAULT 4,
  on_expiry              text    NOT NULL DEFAULT 'remind',
  assign_whole_env       boolean NOT NULL DEFAULT true,
  jira                   jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settings_single_row CHECK (id = 1),
  CONSTRAINT settings_on_expiry_valid
    CHECK (on_expiry IN ('remind','remind-flag','auto-release'))
);
```

`jira` stays `jsonb`: it is four string arrays (`occupyingStatuses`, `releasingStatuses`,
`ignoredStatuses`) plus a handful of flags, always read and written as a whole, never queried by
element. Typed columns would buy nothing and cost a migration per option.

### Jira-derived cache — a genuine consequence of going serverless

In the current system `jiraIssues`, `jiraSkipped` and `lastJiraSyncAt` are **deliberately never
persisted**: they live in process memory, are three-quarters of the board by size, and are refilled by
the sync at boot.

**There is no process memory on Vercel.** Either these are persisted, or every page that shows the
ticket tables re-queries Jira. They must become tables:

```sql
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
  key          text PRIMARY KEY,
  reason       text NOT NULL,
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
```

Arrays are acceptable here **because this is a rebuilt-from-scratch cache, not a source of truth** —
each sync pass truncates and refills. Nothing joins to it, nothing enforces referential integrity
against it, and it is deleted wholesale.

---

## 3. Chat

```sql
CREATE TABLE chat_conversations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL,
  title           text,                      -- groups only; a DM's title is its other member
  -- For a DM: the two auth_users ids sorted and joined, so a second DM between the
  -- same pair is refused by the database rather than by a racy app-level check.
  dm_key          text,
  created_by      uuid        REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,

  CONSTRAINT chat_conversations_kind_valid CHECK (kind IN ('dm','group')),
  CONSTRAINT chat_conversations_dm_key_shape CHECK (
    (kind = 'dm'    AND dm_key IS NOT NULL AND title IS NULL) OR
    (kind = 'group' AND dm_key IS NULL)
  )
);

CREATE UNIQUE INDEX chat_conversations_dm_key_uniq
  ON chat_conversations (dm_key) WHERE dm_key IS NOT NULL;

-- Conversation list ordering: most recently active first, and NULLs (a created
-- but never-used conversation) last.
CREATE INDEX chat_conversations_recent_idx
  ON chat_conversations (last_message_at DESC NULLS LAST);
```

```sql
CREATE TABLE chat_members (
  conversation_id       uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id               uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  member_role           text        NOT NULL DEFAULT 'member',
  joined_at             timestamptz NOT NULL DEFAULT now(),
  -- READ STATE IS A WATERMARK, not a row per message. O(members), not O(messages × members).
  last_read_message_id  bigint,
  last_read_at          timestamptz,
  muted                 boolean     NOT NULL DEFAULT false,

  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT chat_members_role_valid CHECK (member_role IN ('owner','member'))
);

-- "My conversations" — the hottest chat query there is.
CREATE INDEX chat_members_user_idx ON chat_members (user_id);
```

**`chat_members` is the authorization boundary.** Every read and every write checks it, and so does
`/api/pusher/auth` before allowing a subscription to `private-conv-<id>`. Role capabilities decide
*whether you may chat at all*; membership decides *which conversations you may see*. Do not conflate
them, and never let a `superadmin` bypass membership implicitly — if admins are meant to be able to
read any conversation, that is a deliberate product decision
([06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q5), not a fallback.

```sql
CREATE TABLE chat_messages (
  -- bigserial, deliberately: it is the ORDERING key and the pagination cursor.
  -- Never order chat by a client-supplied timestamp; clocks across machines disagree.
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id       uuid        REFERENCES auth_users(id) ON DELETE SET NULL,
  -- Generated by the browser before sending. Makes a retry after a dropped
  -- response idempotent, and lets the composer reconcile its optimistic row.
  client_msg_id   text        NOT NULL,
  body            text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'text',
  reply_to_id     bigint      REFERENCES chat_messages(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT chat_messages_kind_valid CHECK (kind IN ('text','system','attachment')),
  CONSTRAINT chat_messages_body_len   CHECK (length(body) <= 8000)
);

-- Idempotent send. The INSERT uses ON CONFLICT DO NOTHING against this.
CREATE UNIQUE INDEX chat_messages_client_id_uniq
  ON chat_messages (conversation_id, client_msg_id);

-- Keyset pagination: WHERE conversation_id = $1 AND id < $cursor ORDER BY id DESC LIMIT 50
CREATE INDEX chat_messages_conv_id_idx ON chat_messages (conversation_id, id DESC);
```

`sender_id` is `ON DELETE SET NULL`, not `CASCADE`: removing someone's login must not silently delete
their side of every conversation. A null sender renders as a former member.

Deletion is **soft** (`deleted_at`), so `reply_to_id` targets and message ordering survive. The
retention cron is what actually removes rows and their blobs.

```sql
CREATE TABLE chat_attachments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    bigint      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  blob_url      text        NOT NULL,   -- the Vercel Blob URL
  blob_pathname text        NOT NULL,   -- needed to delete the blob later
  filename      text        NOT NULL,
  mime          text        NOT NULL,
  bytes         bigint      NOT NULL,
  width         integer,                -- images only, for layout without a reflow
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_attachments_bytes_positive CHECK (bytes > 0)
);

CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);
```

The Postgres row is the record; the blob is only the bytes. Deleting a message must delete the blob
too — `blob_pathname` exists so the retention job can, and orphaned blobs are billable storage
otherwise.

### What is deliberately *not* a table

| Not stored | Where it lives instead | Why |
|---|---|---|
| **Typing indicators** | Pusher event only, TTL in client memory | Worthless one second later. Never persist. |
| **Presence / online** | Pusher `presence-org` membership | The channel *is* the state. Only `auth_users.last_seen_at` is persisted, for "last seen 20m ago". |
| **Per-message read receipts** | Derived from `chat_members.last_read_message_id` | A receipts table is O(messages × members) for a feature that renders as one tick. Add it only if per-recipient ticks are actually required. |
| **Unread counts** | `COUNT(*) WHERE id > last_read_message_id` | Derived. Cache in the client, never as a column that can drift. |
| **A notifications table** | Derived from watermarks | Add one only if a notification centre or email digest is on the roadmap. |

---

## 4. Index summary

| Index | Serves |
|---|---|
| `auth_users_username_key` | sign-in |
| `auth_users_directory_user_key` (partial unique) | one person, one login |
| `auth_sessions` PK on `token_hash` | every authenticated request |
| `auth_sessions_user_idx` | instant revocation |
| `directory_jira_name_global_key` | Jira label matching must be unambiguous |
| `accounts_display_name_key`, `servers_account_name_key` | Jira Account+Branch matching |
| `claims_server_idx`, `claim_repos_repo_idx` | occupancy derivation |
| `claims_end_time_idx` (partial) | the expiry cron |
| `chat_members_user_idx` | "my conversations" |
| `chat_conversations_recent_idx` | conversation list ordering |
| `chat_messages_conv_id_idx` | keyset pagination, newest-first |
| `chat_messages_client_id_uniq` | idempotent send |
| `chat_conversations_dm_key_uniq` (partial) | one DM per pair |

---

## 5. Authorization posture

Authorization lives in the **application layer** (`requireUser(capability)` plus an explicit
membership check), not in Postgres RLS. One database role, one connection string.

That is the right default here: the app is the only client of this database, the capability list is
already shared between client and server, and RLS would mean threading a per-request identity through
Neon's connection model for no gain.

**If** the database later gains other clients — a BI tool, a second service, direct SQL access for
support — revisit it. RLS on `chat_messages` and `chat_members` would then be worth the cost, because
those are the tables where a missing `WHERE` clause is a privacy incident rather than a bug.

The two rules that must never be violated regardless:

1. **No query against `chat_messages` without a proven membership check** on the same request.
2. **`/api/pusher/auth` is the same boundary in a different shape.** A membership bug there leaks live
   messages to a subscriber, which no amount of correct SQL elsewhere will catch.
