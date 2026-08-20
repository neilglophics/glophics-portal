-- Authentication: logins, sessions, and the evidence trail behind them.
--
-- Nothing in this file is ever broadcast. The board tables in 001 are pushed to
-- every open tab; these are read only by the auth service. Keeping them in
-- separate tables is what makes "could this leak?" a structural question rather
-- than an audit of every projection function in the codebase.

create table auth_users (
  id                   char(36)     not null,
  username             varchar(191) not null,
  username_key         varchar(191) as (lower(trim(username))) stored,
  display_name         varchar(191) not null,
  -- Authorization role: one of the ids in AUTH_ROLES (shared/data.js).
  -- Deliberately no CHECK constraint -- shared/data.js is the single source of
  -- truth for the role set, and a CHECK here would be a second copy that
  -- drifts. roleCan() fails closed on an unknown role, so an unrecognised value
  -- grants nothing; boot validates this column against AUTH_ROLES and complains
  -- loudly rather than silently.
  role                 varchar(32)  not null,

  -- The person on the board this login speaks for. Optional: an operator can
  -- hold a login without appearing in the directory. The unique index tolerates
  -- unlimited NULLs, so "at most one login per person" is enforced without
  -- forcing every login to have one.
  directory_user_id    varchar(64)  null,

  -- A self-describing PHC-style string: "$scrypt$v=1$n=...,r=8,p=1$salt$hash".
  -- Storing the parameters alongside the hash is what makes it possible to
  -- raise them later and re-hash each password on its owner's next sign-in.
  password_hash        varchar(512) not null,
  password_changed_at  datetime(3)  null,
  -- Seeded and admin-reset accounts start here. The pipeline refuses every
  -- route except "read me", "change my password" and "sign out" until cleared.
  must_change_password tinyint(1)   not null default 0,

  active               tinyint(1)   not null default 1,
  created_at           datetime(3)  not null default current_timestamp(3),
  updated_at           datetime(3)  not null default current_timestamp(3),
  last_login_at        datetime(3)  null,

  primary key (id),
  unique key auth_users_username_key (username_key),
  unique key auth_users_directory_key (directory_user_id),
  constraint auth_users_directory_fk
    foreign key (directory_user_id) references directory_users (id)
    on delete set null on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table auth_sessions (
  id                  char(36)     not null,
  user_id             char(36)     not null,
  -- sha256 of the cookie value. The raw token is never stored, so a leaked
  -- backup of this table cannot be replayed as a live session -- which is
  -- exactly what the previous plaintext-token file allowed.
  --
  -- SHA-256 rather than a slow KDF: the token is 32 bytes of uniform
  -- randomness, so there is no dictionary to defend against. The only property
  -- needed is preimage resistance, and paying a KDF on every request to get it
  -- would be a self-inflicted denial of service.
  token_sha256        varbinary(32) not null,
  -- Minted with the session, handed to the browser, required back as a header
  -- on every mutating request. Bound to the session, so it cannot be guessed or
  -- planted by anyone who cannot already read the session cookie.
  csrf_token          varchar(64)  not null,

  created_at          datetime(3)  not null default current_timestamp(3),
  last_seen_at        datetime(3)  not null default current_timestamp(3),
  idle_expires_at     datetime(3)  not null,
  absolute_expires_at datetime(3)  not null,

  created_ip          varchar(64)  null,
  user_agent          varchar(512) null,
  -- Soft revocation. The audit log references sessions, and a deleted row makes
  -- the trail unreadable exactly when somebody is trying to read it.
  revoked_at          datetime(3)  null,
  revoked_reason      varchar(64)  null,

  primary key (id),
  unique key auth_sessions_token_key (token_sha256),
  key auth_sessions_user_idx (user_id),
  key auth_sessions_sweep_idx (absolute_expires_at),
  constraint auth_sessions_user_fk
    foreign key (user_id) references auth_users (id) on delete cascade on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Sign-in attempts. Append-only, and persistent: the previous in-memory counter
-- reset on every restart, so a crash loop defeated it entirely.
create table auth_attempts (
  id            bigint unsigned not null auto_increment,
  attempted_at  datetime(3)     not null default current_timestamp(3),
  username_norm varchar(191)    not null,
  client_ip     varchar(64)     null,
  outcome       varchar(32)     not null,
  user_agent    varchar(512)    null,
  primary key (id),
  key auth_attempts_user_idx (username_norm, attempted_at),
  key auth_attempts_ip_idx (client_ip, attempted_at),
  constraint auth_attempts_outcome_chk
    check (outcome in ('success', 'bad-password', 'no-such-user', 'deactivated', 'throttled'))
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Third-party credentials, encrypted with AES-256-GCM under APP_SECRET_KEY.
-- The secret's name is the additional authenticated data, so a ciphertext
-- cannot be lifted from one row and replayed into another.
create table secrets (
  name        varchar(191)   not null,
  ciphertext  varbinary(4096) not null,
  iv          varbinary(12)  not null,
  auth_tag    varbinary(16)  not null,
  key_version int            not null default 1,
  updated_at  datetime(3)    not null default current_timestamp(3),
  updated_by  char(36)       null,
  primary key (name),
  constraint secrets_updated_by_fk
    foreign key (updated_by) references auth_users (id) on delete set null on update cascade
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;
