const scheduler = require("./scheduler.js");
const claims = require("../services/claims.service.js");
const { HEALTH_CHECK_INTERVAL_MS } = require("../services/health.service.js");

function start() {
  scheduler.schedule("claim-expiry", HEALTH_CHECK_INTERVAL_MS, claims.releaseExpired);
}

module.exports = { start };
