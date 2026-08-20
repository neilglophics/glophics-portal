const scheduler = require("./scheduler.js");
const health = require("../services/health.service.js");

function start() {
  scheduler.schedule("health-check", health.HEALTH_CHECK_INTERVAL_MS, health.runHealthChecks, {
    runImmediately: true
  });
}

module.exports = { start };
