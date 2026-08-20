const scheduler = require("./scheduler.js");
const jiraSync = require("../services/jira-sync.service.js");

// The interval a poll is attempted at, not the interval it actually runs at --
// runJiraSync() self-throttles against settings.jira.pollIntervalMinutes, same
// as the previous implementation. This just has to be frequent enough that a
// one-minute setting is honoured promptly.
const ATTEMPT_INTERVAL_MS = 20_000;

function start() {
  scheduler.schedule("jira-sync", ATTEMPT_INTERVAL_MS, () => jiraSync.runJiraSync({ force: false }), {
    runImmediately: true
  });
}

module.exports = { start };
