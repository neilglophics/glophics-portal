-- Jira-derived data.
--
-- Previously these three things lived only in memory, were stripped before
-- every save, and were rebuilt from scratch on each poll -- which meant the
-- board was blank for Jira after every restart, and every poll rebroadcast the
-- entire board to every tab whether anything had changed or not.
--
-- As tables they survive a restart, and the content hash below turns "did
-- anything actually change?" from a guess into a comparison.

create table jira_issues (
  `key`         varchar(64)  not null,
  server_id     varchar(64)  null,
  account_name  varchar(191) null,
  branch        varchar(191) null,
  -- Matched at sync time against the account's repositories and the directory.
  -- JSON arrays, not join tables: this is derived data, rewritten wholesale by
  -- the sync and never queried element-wise.
  repos         json         not null default '[]',
  user_ids      json         not null default '[]',
  raw_assignees json         not null default '[]',
  status        varchar(191) not null default '',
  summary       text         null,
  start_time    datetime(3)  null,
  end_time      datetime(3)  null,
  -- sha256 over every column above, canonically serialised. The sync compares
  -- incoming hashes against these and writes only the rows that differ, so an
  -- idle poll performs no writes and tells the browsers nothing.
  content_hash  varbinary(32) not null,
  sync_run_id   bigint unsigned not null,
  seen_at       datetime(3)  not null default current_timestamp(3),
  primary key (`key`),
  key jira_issues_server_idx (server_id),
  key jira_issues_run_idx (sync_run_id),
  -- ON DELETE SET NULL, matching servers.account_id: an issue that pointed at a
  -- deleted environment is still worth showing, it just no longer has a home.
  constraint jira_issues_server_fk
    foreign key (server_id) references servers (id) on delete set null on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Issues that would occupy an environment but could not be matched to one, with
-- the reason, so the "Not tracked" page can explain itself.
create table jira_skipped (
  `key`        varchar(64)  not null,
  reason       varchar(512) not null,
  status       varchar(191) null,
  account_name varchar(191) null,
  branch       varchar(191) null,
  content_hash varbinary(32) not null,
  sync_run_id  bigint unsigned not null,
  seen_at      datetime(3)  not null default current_timestamp(3),
  primary key (`key`),
  key jira_skipped_run_idx (sync_run_id)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table jira_sync_runs (
  id            bigint unsigned not null auto_increment,
  mode          varchar(16)  not null,
  started_at    datetime(3)  not null default current_timestamp(3),
  finished_at   datetime(3)  null,
  issue_count   int          null,
  changed_count int          null,
  skipped_count int          null,
  error         varchar(512) null,
  primary key (id),
  key jira_sync_runs_started_idx (started_at),
  constraint jira_sync_runs_mode_chk check (mode in ('full', 'incremental'))
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Watermarks. `last_full_sweep_at` is what makes the incremental window safe:
-- an incremental pass may only delete issues it explicitly reclassified, and
-- everything else is garbage-collected by the periodic full sweep.
create table sync_state (
  id                 tinyint(1)   not null default 1,
  last_jira_sync_at  datetime(3)  null,
  last_full_sweep_at datetime(3)  null,
  last_jira_error    varchar(512) null,
  updated_at         datetime(3)  not null default current_timestamp(3),
  primary key (id),
  constraint sync_state_singleton_chk check (id = 1)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;
