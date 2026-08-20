/**
 * Housekeeping: prunes the tables that would otherwise grow forever.
 *
 * Runs once an hour. Nothing here is urgent, so hourly is generous rather than
 * required -- the point is that it runs at all, unattended.
 */
const scheduler = require("./scheduler.js");
const sessionService = require("../services/session.service.js");
const throttleService = require("../services/throttle.service.js");
const auditService = require("../services/audit.service.js");
const boardEventsRepo = require("../repositories/board-events.repo.js");
const { db } = require("../db/client.js");

const HOUR_MS = 60 * 60 * 1000;
// Board events are a catch-up buffer for SSE resume, not a history -- ten
// minutes is far more than any real reconnect gap needs.
const BOARD_EVENTS_RETENTION_MS = 10 * 60 * 1000;

async function run() {
  const sessionsRemoved = await sessionService.sweep();
  const attemptsRemoved = await throttleService.sweep();
  const auditRemoved = await auditService.applyRetention();
  const eventsRemoved = await boardEventsRepo.prune(db, BOARD_EVENTS_RETENTION_MS);

  if (sessionsRemoved || attemptsRemoved || auditRemoved.short || auditRemoved.long || eventsRemoved) {
    console.log(
      `[janitor] sessions=${sessionsRemoved} attempts=${attemptsRemoved} ` +
      `audit-short=${auditRemoved.short} audit-long=${auditRemoved.long} events=${eventsRemoved}`
    );
  }
}

function start() {
  scheduler.schedule("janitor", HOUR_MS, run, { jitterMs: 60_000 });
}

module.exports = { start, run };
