-- The board: the people, accounts, environments, claims and notes the UI draws.
--
-- Conventions used throughout the schema, decided once here:
--
--   * Primary keys are varchar, not integers or UUIDs. Ids in this application
--     are meaningful and are minted by the client ("server-01", "singaprinting",
--     "PROJ-412"); they are referenced by note keys and by data-* attributes in
--     the DOM. Re-keying would be a migration with no way back and no benefit.
--
--   * Case-insensitive uniqueness is a STORED generated column plus a unique
--     index on it. MariaDB 10.4 has no functional indexes, and this is the
--     portable equivalent -- it also has the advantage that the normalised form
--     is visible in a SELECT when you are working out why a duplicate was
--     rejected.
--
--   * Timestamps are datetime(3) holding UTC, never the TIMESTAMP type. TIMESTAMP
--     silently converts against the session time zone and runs out in 2038.
--     The driver pins every session to +00:00.
--
--   * A unique index containing a nullable column allows unlimited NULLs in
--     MySQL and MariaDB. That is used deliberately below where a partial index
--     would be used on Postgres, and is noted where it matters.

-- ---------------------------------------------------------------- directory --
-- The people a claim can be attributed to. This table is broadcast to every
-- signed-in browser. It holds no credentials -- those are in auth_users, and
-- the separation is the reason a leak here is a leak of names, not of logins.
create table directory_users (
  id         varchar(64)  not null,
  name       varchar(191) not null,
  name_key   varchar(191) as (lower(trim(name))) stored,
  -- Job function ("Backend", "QA"), free text. Deliberately NOT the
  -- authorization role: that lives on auth_users.role and is a closed set.
  job_title  varchar(191) not null default '',
  position   int          not null default 0,
  created_at datetime(3)  not null default current_timestamp(3),
  updated_at datetime(3)  not null default current_timestamp(3),
  primary key (id),
  unique key directory_users_name_key (name_key)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Jira display names this person answers to. A table rather than a JSON array
-- for one reason: the label must be unique across ALL people, and a cross-row
-- uniqueness rule over array elements cannot be a constraint.
create table directory_user_jira_names (
  label_key varchar(191) not null,
  label     varchar(191) not null,
  user_id   varchar(64)  not null,
  position  int          not null default 0,
  primary key (label_key),
  key directory_user_jira_names_user_idx (user_id),
  constraint directory_user_jira_names_user_fk
    foreign key (user_id) references directory_users (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- accounts --
create table accounts (
  id               varchar(64)  not null,
  display_name     varchar(191) not null,
  display_name_key varchar(191) as (lower(trim(display_name))) stored,
  position         int          not null default 0,
  created_at       datetime(3)  not null default current_timestamp(3),
  updated_at       datetime(3)  not null default current_timestamp(3),
  primary key (id),
  unique key accounts_display_name_key (display_name_key)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table account_repositories (
  account_id varchar(64)  not null,
  repo_name  varchar(191) not null,
  position   int          not null default 0,
  primary key (account_id, repo_name),
  constraint account_repositories_account_fk
    foreign key (account_id) references accounts (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- environments --
create table servers (
  id         varchar(64)  not null,
  name       varchar(191) not null,
  name_key   varchar(191) as (lower(trim(name))) stored,
  -- Nullable, ON DELETE SET NULL, deliberately: deleting an account is
  -- documented in the UI as leaving its environments "without an account".
  -- An FK that blocked or cascaded would change behaviour the user relies on.
  account_id varchar(64)  null,
  position   int          not null default 0,
  created_at datetime(3)  not null default current_timestamp(3),
  updated_at datetime(3)  not null default current_timestamp(3),
  primary key (id),
  -- Two environments may share a name under different accounts. Because
  -- account_id is nullable, orphaned environments are exempt from this rule --
  -- which is what we want: they were valid when their account existed and must
  -- not become un-editable because it was deleted.
  unique key servers_account_name_key (account_id, name_key),
  constraint servers_account_fk
    foreign key (account_id) references accounts (id) on delete set null on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table server_repos (
  server_id  varchar(64)   not null,
  repo_name  varchar(191)  not null,
  url        varchar(2048) not null default '',
  health     varchar(16)   not null default 'unconfigured',
  checked_at datetime(3)   null,
  position   int           not null default 0,
  primary key (server_id, repo_name),
  key server_repos_health_idx (health),
  constraint server_repos_health_chk
    check (health in ('online', 'offline', 'checking', 'unconfigured')),
  constraint server_repos_server_fk
    foreign key (server_id) references servers (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- -------------------------------------------------------------------- notes --
-- The client sees these as a flat map keyed "<serverId>::<repoName>". The
-- separator was a workaround for JSON objects having only string keys; here
-- the pair is the primary key and it disappears. The FK to server_repos is
-- what makes "a repo removed from an account takes its note with it" automatic.
create table repo_notes (
  server_id  varchar(64)  not null,
  repo_name  varchar(191) not null,
  body       text         not null,
  updated_at datetime(3)  not null default current_timestamp(3),
  updated_by varchar(64)  null,
  primary key (server_id, repo_name),
  constraint repo_notes_repo_fk
    foreign key (server_id, repo_name) references server_repos (server_id, repo_name)
    on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------- claims --
-- What the UI calls "tickets": a hold on one or more repositories of one
-- environment, either raised by hand or mirrored from a Jira issue.
create table claims (
  id             varchar(64)  not null,
  source         varchar(16)  not null,
  server_id      varchar(64)  not null,
  account_name   varchar(191) not null default '',
  branch         varchar(191) not null default '',
  status         varchar(191) not null default '',
  summary        text         null,
  note           text         null,
  -- Opaque Jira labels: no identity, no foreign key, never filtered on.
  -- Normalising them would buy nothing and cost a join on every read.
  raw_assignees  json         not null default '[]',
  start_time     datetime(3)  null,
  end_time       datetime(3)  null,
  claimed_at     datetime(3)  not null default current_timestamp(3),
  last_synced_at datetime(3)  null,
  created_at     datetime(3)  not null default current_timestamp(3),
  updated_at     datetime(3)  not null default current_timestamp(3),
  primary key (id),
  key claims_server_idx (server_id),
  key claims_expiry_idx (end_time),
  key claims_source_idx (source),
  constraint claims_source_chk check (source in ('jira', 'manual')),
  constraint claims_server_fk
    foreign key (server_id) references servers (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table claim_repos (
  claim_id  varchar(64)  not null,
  repo_name varchar(191) not null,
  position  int          not null default 0,
  primary key (claim_id, repo_name),
  key claim_repos_repo_idx (repo_name),
  constraint claim_repos_claim_fk
    foreign key (claim_id) references claims (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table claim_users (
  claim_id varchar(64) not null,
  -- Deliberately NOT a foreign key. Deleting a person leaves their past claims
  -- attributed to the id, and the UI renders the raw id as a fallback label.
  -- An FK would either block the delete or silently erase the attribution.
  user_id  varchar(64) not null,
  position int         not null default 0,
  primary key (claim_id, user_id),
  key claim_users_user_idx (user_id),
  constraint claim_users_claim_fk
    foreign key (claim_id) references claims (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- settings --
create table app_settings (
  id                    tinyint(1)  not null default 1,
  default_booking_hours int         not null default 4,
  on_expiry             varchar(32) not null default 'remind',
  assign_whole_env      tinyint(1)  not null default 1,
  -- JSON on purpose. This is six flags and three arrays of status names, read
  -- whole on every page load and written whole when a checkbox moves. Split
  -- into tables it would cost a join per read and six row writes per click,
  -- and enforce nothing that is not already enforced in the service.
  jira                  json        not null default '{}',
  updated_at            datetime(3) not null default current_timestamp(3),
  primary key (id),
  constraint app_settings_singleton_chk check (id = 1),
  constraint app_settings_hours_chk     check (default_booking_hours > 0),
  constraint app_settings_expiry_chk
    check (on_expiry in ('remind', 'remind-flag', 'auto-release'))
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- The Jira connection, minus the token: the token is a secret and lives in the
-- `secrets` table, encrypted. Keeping them apart means a `select *` here is
-- safe to paste into a bug report.
create table jira_connection (
  id         tinyint(1)   not null default 1,
  base_url   varchar(512) not null default '',
  email      varchar(191) not null default '',
  updated_at datetime(3)  not null default current_timestamp(3),
  primary key (id),
  constraint jira_connection_singleton_chk check (id = 1)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;
