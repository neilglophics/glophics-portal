-- The three single-row tables, created empty by 001 and 003, given their
-- starting values here.
--
-- Deliberately only the singletons. The demo board -- three people, eight
-- accounts, eight environments -- is NOT seeded by a migration: a real
-- deployment restoring its own data must not find eight fictional environments
-- waiting for it. That lives behind `npm run seed:demo`.
--
-- The jira object mirrors DEFAULT_SETTINGS.jira in shared/data.js. It is
-- duplicated here rather than read from JavaScript because a migration must
-- describe a fixed historical state: if someone changes the default in
-- shared/data.js next year, this migration must still produce what it produced
-- the day it ran, or the checksum guard becomes a lie.

insert into app_settings (id, default_booking_hours, on_expiry, assign_whole_env, jira)
values (
  1, 4, 'remind', 1,
  '{"enabled": false,
    "requireTicket": true,
    "pullTicketInfo": true,
    "commentOnRelease": false,
    "occupyingStatuses": ["QA TESTING (DEV)", "QA TESTING (STG)"],
    "releasingStatuses": ["FINAL CHECKING", "DONE"],
    "ignoredStatuses": ["OPEN", "TO REVIEW", "ON HOLD", "CANCELLED", "DONE", "CLOSED"],
    "pollIntervalMinutes": 1,
    "autoSync": true}'
)
on duplicate key update id = id;

insert into jira_connection (id) values (1) on duplicate key update id = id;
insert into sync_state (id) values (1) on duplicate key update id = id;
