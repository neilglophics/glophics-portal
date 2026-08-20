const health = require("../services/health.service.js");

async function checkNow() {
  try {
    await health.runHealthChecks();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Health check failed." };
  }
}

module.exports = { checkNow };
