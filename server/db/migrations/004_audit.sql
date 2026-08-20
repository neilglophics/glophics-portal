-- Who did what, when, and whether it worked.
--
-- Append-only by convention and by code: no UPDATE or DELETE against this table
-- exists anywhere except the retention job, which lives in its own module.

create table audit_log (
  id               bigint unsigned not null auto_increment,
  occurred_at      datetime(3)  not null default current_timestamp(3),

  actor_user_id    char(36)     null,
  -- Denormalised on purpose. "Who deleted @jerome" has to still read correctly
  -- after both accounts are gone, which a join cannot give you.
  actor_username   varchar(191) null,
  actor_role       varchar(32)  null,
  actor_ip         varchar(64)  null,
  actor_session_id char(36)     null,
  actor_user_agent varchar(512) null,

  event            varchar(64)  not null,
  outcome          varchar(16)  not null,
  target_type      varchar(32)  null,
  target_id        varchar(191) null,
  target_label     varchar(191) null,
  -- Filtered through an allowlist of key names before it is written. A denylist
  -- would fail the first time somebody names a field "newPass".
  detail           json         not null default '{}',

  primary key (id),
  key audit_log_time_idx (occurred_at),
  key audit_log_actor_idx (actor_user_id, occurred_at),
  key audit_log_event_idx (event, occurred_at),
  key audit_log_target_idx (target_type, target_id, occurred_at),
  constraint audit_log_outcome_chk check (outcome in ('success', 'failure')),
  -- ON DELETE SET NULL rather than CASCADE: deleting a login must not delete
  -- the record of what it did. actor_username survives to name them.
  constraint audit_log_actor_fk
    foreign key (actor_user_id) references auth_users (id) on delete set null on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;
