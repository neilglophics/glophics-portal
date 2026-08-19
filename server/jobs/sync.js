/**
 * The two passes that move claims without anyone asking: the bulk Jira sync,
 * and plain time-based expiry.
 */

const Board = require("../board.js");
const {
  matchRepositoriesToKeys, matchUserIdsByLabels, findServerForTicket,
  statusIn, statusFrees, statusIsTerminal
} = require("../../shared/data.js");
const {
  normalizeBaseUrl, jiraIssuePath, jiraBrowseUrl,
  loadJiraConfig, jiraConfigured, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
} = require("../jira-client.js");

// ---------- Bulk Jira sync ----------
// Instead of looking up one ticket at a time, this pulls every ticket Jira
// has touched recently in one search and derives each environment's
// occupancy from the results — no manual "book this ticket" step needed.
//
// A ticket claims its matched repos the moment its status first enters
// settings.jira.occupyingStatuses, and releases them the moment its status
// enters settings.jira.releasingStatuses — or the moment it is closed,
// cancelled or done, which frees the environment whatever the lists say
// (see statusFrees in shared/data.js). Any *other* status leaves an
// already-active claim untouched (e.g. QA FAILED doesn't free the
// environment — the ticket bounced back, it's still being worked). This
// means claims are stateful: they live in Board.state.tickets and only sync()
// adds/removes them, never a plain "recompute from current status" pass.
//
// The search window (`updated >= -30d`) is a practical bound, not a
// guarantee: a claim that's genuinely still open but hasn't been touched
// in Jira for 30+ days won't be re-confirmed by a sync pass, but it also
// won't be silently dropped — it just stays claimed until the ticket is
// updated again (or someone hits Force free).

// Plain time-based expiry — independent of Jira, applies to every claim
// (manual or jira-sourced) that has an endTime. Only acts when
// settings.onExpiry is "auto-release"; "remind"/"remind-flag" are display-
// only and need no server-side action.
function runExpiryChecks() {
  if (Board.state.settings.onExpiry !== "auto-release") return;
  const now = Date.now();
  const before = Board.state.tickets.length;
  Board.state.tickets = Board.state.tickets.filter((t) => !(t.endTime && new Date(t.endTime).getTime() <= now));
  if (Board.state.tickets.length !== before) { Board.persist(); Board.broadcast(); }
}

const JIRA_SYNC_WINDOW = "updated >= -30d";
const JIRA_SYNC_PAGE_SIZE = 100;
// Bounds one sync at 500 issues so a large backlog can't stall the poll.
const JIRA_SYNC_MAX_PAGES = 5;
let lastJiraSyncAt = 0;
let lastJiraSyncError = null;

// Uses /rest/api/3/search/jql — the old /rest/api/3/search was removed by
// Atlassian and now answers 410. The replacement pages with an opaque
// nextPageToken cursor rather than startAt, and reports the end with isLast.
// A JQL string literal. Status names carry spaces and brackets, so they
// are always quoted; a stray quote or backslash in one is escaped rather
// than left to break the query.
const jqlText = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Issue keys go in unquoted, and only if they look like keys — the list is
// built from stored claims, and anything that isn't a real Jira key would
// only be a way to break the query.
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * What the sync asks Jira for: everything updated in the window, minus the
 * statuses configured as never fetched, plus — by key — whatever is holding
 * repositories right now.
 *
 * That last clause is the whole reason this is one query rather than a
 * constant. A claim ends when its ticket reaches a releasing status, and
 * DONE is both a releasing status and one nobody wants pulled in bulk. If
 * the sync stopped seeing held tickets, the environment would stay held
 * forever with no way for Jira to say otherwise.
 */
function buildSyncJql(jira) {
  const ignored = (jira.ignoredStatuses || []).filter(Boolean);
  const window = ignored.length
    ? `(${JIRA_SYNC_WINDOW} AND status NOT IN (${ignored.map(jqlText).join(", ")}))`
    : JIRA_SYNC_WINDOW;

  const held = Board.state.tickets
    .filter((t) => t.source === "jira" && JIRA_KEY.test(t.id))
    .map((t) => t.id);

  const where = held.length ? `${window} OR key IN (${held.join(", ")})` : window;
  return `${where} ORDER BY updated DESC`;
}

async function fetchJiraSearchIssues(config, fieldIds, query) {
  const jql = encodeURIComponent(query);
  const fields = encodeURIComponent(Array.from(fieldIds).join(","));
  const base = normalizeBaseUrl(config.baseUrl);
  const issues = [];
  let token = null;

  for (let page = 0; page < JIRA_SYNC_MAX_PAGES; page++) {
    const cursor = token ? `&nextPageToken=${encodeURIComponent(token)}` : "";
    const url = `${base}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=${JIRA_SYNC_PAGE_SIZE}${cursor}`;
    const response = await fetch(url, {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Jira search returned ${response.status}`);
    const data = await response.json();
    issues.push(...(data.issues || []));
    token = data.nextPageToken;
    if (data.isLast || !token) break;
  }
  return issues;
}

function extractTicketFields(issue, fieldMap) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary || "",
    status: f.status ? f.status.name : "Unknown",
    statusCategory: f.status ? f.status.statusCategory.key : "new",
    ticketAssignees: pickFieldValue(f, fieldMap["ticket assignee"]) || [],
    accountName: firstOf(pickFieldValue(f, fieldMap["account name"])),
    branch: firstOf(pickFieldValue(f, fieldMap["branch"])),
    repository: pickFieldValue(f, fieldMap["repository"]) || [],
    startDate: pickFieldValue(f, fieldMap["start date"]),
    dueDate: pickFieldValue(f, fieldMap["due date"])
  };
}

async function runJiraSync(force) {
  if (!Board.state.settings.jira.enabled) return { ok: false, reason: "disabled" };
  if (!force && !Board.state.settings.jira.autoSync) return { ok: false, reason: "auto-sync-off" };
  const config = loadJiraConfig();
  if (!config) return { ok: false, reason: "not-configured" };

  const intervalMs = Math.max(1, Board.state.settings.jira.pollIntervalMinutes || 1) * 60000;
  if (!force && Date.now() - lastJiraSyncAt < intervalMs) return { ok: false, reason: "throttled" };
  lastJiraSyncAt = Date.now();

  try {
    const fieldMap = await loadFieldIdMap(config);
    const fieldIds = new Set(["summary", "status"]);
    AUTOFILL_FIELD_NAMES.forEach((name) => (fieldMap[name] || []).forEach((id) => fieldIds.add(id)));

    const jira = Board.state.settings.jira;
    const issues = await fetchJiraSearchIssues(config, fieldIds, buildSyncJql(jira));
    const skipped = [];
    const onBoard = [];

    /**
     * Everything the sync saw that is not an active claim, in the shape the
     * ticket tables read. A ticket holds repositories only at an occupying
     * status, but it is somebody's ticket at every status — so this keeps
     * the assignees, dates and matched environment rather than a bare
     * count, and the tables can offer the whole workflow as a filter.
     *
     * What bounds the list is the JIRA_SYNC_WINDOW query, not the status:
     * one record per issue updated in the window, refilled from scratch on
     * every pass.
     */
    const record = (t) => {
      const { server } = findServerForTicket(t, Board.state.accounts, Board.state.servers);
      const repoCheck = server
        ? matchRepositoriesToKeys(t.repository, Object.keys(server.repos))
        : { matched: [] };
      onBoard.push({
        key: t.key,
        serverId: server ? server.id : null,
        accountName: t.accountName,
        branch: t.branch,
        repos: repoCheck.matched,
        userIds: matchUserIdsByLabels(t.ticketAssignees, Board.state.users).matched,
        rawAssignees: t.ticketAssignees,
        status: t.status,
        summary: t.summary,
        // Dates as Jira has them. Nothing is being held, so unlike a claim
        // there is no "it started now" to fall back on.
        startTime: t.startDate ? new Date(`${t.startDate}T09:00`).toISOString() : null,
        endTime: t.dueDate ? new Date(`${t.dueDate}T18:00`).toISOString() : null
      });
    };

    issues.forEach((issue) => {
      const t = extractTicketFields(issue, fieldMap);
      const existing = Board.state.tickets.find((tk) => tk.id === t.key && tk.source === "jira");

      // Pulled by key, or newly at a status nobody wants listed. Either
      // way it is not carried — that is what "never fetched" means.
      const ignored = statusIn(jira.ignoredStatuses, t.status);

      if (existing) {
        if (!statusFrees(jira, t.status)) {
          // Sticky: repos/serverId/userIds don't move mid-claim — only the
          // display-facing fields refresh each pass.
          existing.status = t.status;
          existing.summary = t.summary;
          existing.lastSyncedAt = new Date().toISOString();
          return;
        }
        // Released: it stops holding repositories. It stays in the tables
        // at its new status unless that status is one we don't carry.
        Board.state.tickets = Board.state.tickets.filter((tk) => tk !== existing);
        if (!ignored) record(t);
        return;
      }

      if (ignored) return;

      // A ticket that is finished or cancelled takes no environment, even
      // if someone has ticked its status as occupying — without this it
      // would claim on one pass and be freed on the next, forever.
      if (statusIsTerminal(t.status) || !statusIn(jira.occupyingStatuses, t.status)) {
        record(t);
        return;
      }

      const { server, error } = findServerForTicket(t, Board.state.accounts, Board.state.servers);
      if (error) {
        skipped.push({ key: t.key, reason: error, status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        return;
      }

      if (!t.repository || !t.repository.length) {
        skipped.push({ key: t.key, reason: "Repository field is empty.", status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        return;
      }
      const repoCheck = matchRepositoriesToKeys(t.repository, Object.keys(server.repos));
      if (!repoCheck.matched.length) {
        skipped.push({ key: t.key, reason: `Repository field ("${t.repository.join(", ")}") doesn't match any repo on ${server.name}.`, status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        return;
      }

      const userMatch = matchUserIdsByLabels(t.ticketAssignees, Board.state.users);
      const startTime = t.startDate ? new Date(`${t.startDate}T09:00`).toISOString() : new Date().toISOString();
      const endTime = t.dueDate ? new Date(`${t.dueDate}T18:00`).toISOString() : null;

      Board.state.tickets.push({
        id: t.key,
        source: "jira",
        serverId: server.id,
        accountName: t.accountName,
        branch: t.branch,
        repos: repoCheck.matched,
        userIds: userMatch.matched,
        rawAssignees: t.ticketAssignees,
        status: t.status,
        summary: t.summary,
        note: null,
        startTime,
        endTime,
        claimedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString()
      });
    });

    Board.state.jiraSkipped = skipped;
    Board.state.jiraIssues = onBoard;
    lastJiraSyncError = null;
    Board.state.lastJiraSyncAt = new Date().toISOString();
    // jiraSkipped/lastJiraSyncAt update every pass regardless of `changed` —
    // always worth a broadcast so the sync bar's "synced Xs ago" stays live.
    Board.persist();
    Board.broadcast();
    return { ok: true, issueCount: issues.length, skippedCount: skipped.length };
  } catch (err) {
    lastJiraSyncError = err.message || "Jira sync failed.";
    return { ok: false, reason: "error", error: lastJiraSyncError };
  }
}

module.exports = { runJiraSync, runExpiryChecks };
