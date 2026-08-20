/**
 * The board projection: the single object `GET /api/state` returns and the
 * first SSE frame carries.
 *
 * This is the one place that knows the wire shape the browser expects, and it
 * is deliberately assembled in JavaScript from small queries rather than built
 * by one large SQL statement. The projection has to match a hand-written client
 * exactly; an unreadable json_object nest would make the next change to it a
 * gamble, and the queries it replaces are indexed lookups costing microseconds.
 *
 * Every read runs inside one consistent snapshot, so the payload is a state the
 * world actually had, rather than eight consecutive states stitched together.
 */

const { snapshot } = require("../db/client.js");
const directoryUsers = require("./directory-users.repo.js");
const accounts = require("./accounts.repo.js");
const servers = require("./servers.repo.js");
const claims = require("./claims.repo.js");
const notes = require("./notes.repo.js");
const settings = require("./settings.repo.js");
const jira = require("./jira-issues.repo.js");
const syncState = require("./sync-state.repo.js");
const boardEvents = require("./board-events.repo.js");

/**
 * Assembles the projection using the given executor.
 *
 * `seq` rides along with the payload so a browser can tell where in the event
 * stream this snapshot was taken, and therefore whether a frame that arrives
 * afterwards is the next one or whether it missed something.
 */
async function project(db) {
  // Sequential, not Promise.all: the driver runs one command at a time per
  // connection, so concurrency here would buy nothing and only obscure the
  // order in which the snapshot is read.
  const users = await directoryUsers.list(db);
  const accountRows = await accounts.list(db);
  const serverRows = await servers.list(db);
  const claimRows = await claims.list(db);
  const noteMap = await notes.asMap(db);
  const settingsRow = await settings.get(db);
  const issues = await jira.listIssues(db);
  const skipped = await jira.listSkipped(db);
  const sync = await syncState.get(db);
  const seq = await boardEvents.latestSeq(db);

  return {
    users,
    accounts: accountRows,
    servers: serverRows,
    // The client calls claims "tickets" throughout, and every UI file reads
    // appData.tickets. The rename stops at this boundary.
    tickets: claimRows,
    notes: noteMap,
    settings: settingsRow,
    jiraIssues: issues,
    jiraSkipped: skipped,
    lastJiraSyncAt: sync.lastJiraSyncAt,
    __seq: seq
  };
}

/** The projection on its own consistent snapshot. */
async function load() {
  return snapshot((tx) => project(tx));
}

module.exports = { project, load };
