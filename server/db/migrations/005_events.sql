-- The realtime event log.
--
-- Every change to the board appends one row here and fans it out to the open
-- SSE streams. Giving each frame a monotone id buys three things a plain
-- in-process emitter cannot:
--   * a browser that missed frames can tell (a gap in `seq`) and resynchronise
--     with one request, rather than silently drifting from the truth;
--   * a reconnecting tab can resume from Last-Event-ID instead of refetching;
--   * a second process could catch up by reading rows it has not seen.
--
-- Pruned to a short window by the janitor: this is a catch-up buffer, not a
-- history. The audit log is the history.

create table board_events (
  seq        bigint unsigned not null auto_increment,
  type       varchar(64)  not null,
  payload    json         not null,
  -- The client id of whoever caused it, echoed back so the originating tab can
  -- skip its own echo. An optimisation only: every reducer is idempotent, so
  -- applying your own echo is correct, merely wasteful.
  origin     varchar(64)  null,
  created_at datetime(3)  not null default current_timestamp(3),
  primary key (seq),
  key board_events_created_idx (created_at)
) engine=InnoDB row_format=DYNAMIC default charset=utf8mb4 collate=utf8mb4_unicode_ci;
