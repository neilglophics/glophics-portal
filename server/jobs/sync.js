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
// already-active claim in place (e.g. QA FAILED doesn't free the
// environment — the ticket bounced back, it's still being worked). This
// means *whether* a ticket holds anything is stateful: claims live in
// Board.state.tickets and only sync() adds/removes them, never a plain
// "recompute from current status" pass.
//
// *What* it holds is not stateful. Every pass re-derives the placement —
// which environment, which repos, which people, which dates — from the
// ticket's current fields (see placeTicket), so an edit in Jira moves the
// claim with it. A ticket retargeted from SG_hotfix-2 to SG_hotfix-1 has to
// stop holding the first and start holding the second on the next pass;
// leaving it where it was claimed means the old environment reads as held by
// a ticket that left it, and the new one reads as free.
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
    updated: f.updated || null,
    ticketAssignees: pickFieldValue(f, fieldMap["ticket assignee"]) || [],
    accountName: firstOf(pickFieldValue(f, fieldMap["account name"])),
    branch: firstOf(pickFieldValue(f, fieldMap["branch"])),
    repository: pickFieldValue(f, fieldMap["repository"]) || [],
    startDate: pickFieldValue(f, fieldMap["start date"]),
    dueDate: pickFieldValue(f, fieldMap["due date"])
  };
}

/**
 * Where a ticket belongs right now, decided only from what Jira currently
 * says: which environment (Account Name + Branch), which of that
 * environment's repos (Repository), and who is on it (Ticket Assignee).
 *
 * The first claim and every later refresh both go through here, so a ticket
 * edited after it was claimed is placed by exactly the rules that placed it
 * the first time — there is no second, more forgiving path that only a
 * moved ticket takes.
 *
 * An `error` means Jira no longer says where this ticket goes. Nothing is
 * guessed and no earlier answer is reused: the caller reports the reason and
 * the ticket holds nothing until the fields say where.
 */
function placeTicket(t) {
  const { server, error } = findServerForTicket(t, Board.state.accounts, Board.state.servers);
  if (error) return { error };
  if (!t.repository || !t.repository.length) return { error: "Repository field is empty." };
  const repoCheck = matchRepositoriesToKeys(t.repository, Object.keys(server.repos));
  if (!repoCheck.matched.length) {
    return { error: `Repository field ("${t.repository.join(", ")}") doesn't match any repo on ${server.name}.` };
  }
  return {
    server,
    repos: repoCheck.matched,
    userIds: matchUserIdsByLabels(t.ticketAssignees, Board.state.users).matched
  };
}

// Jira's dates, in the shape a claim stores them. A ticket with no start
// date keeps the start it already had rather than being re-dated to "now"
// every pass — that would reset "held since" once a minute.
const claimStart = (t, previous) =>
  t.startDate ? new Date(`${t.startDate}T09:00`).toISOString()
    : (previous || new Date().toISOString());
const claimEnd = (t) => (t.dueDate ? new Date(`${t.dueDate}T18:00`).toISOString() : null);

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
    const fieldIds = new Set(["summary", "status", "updated"]);
    AUTOFILL_FIELD_NAMES.forEach((name) => (fieldMap[name] || []).forEach((id) => fieldIds.add(id)));

    /**
     * Whether this pass can actually see the fields a placement is decided
     * from. loadFieldIdMap answers {} when Jira's field list is unreachable
     * and nothing is cached yet, and every ticket then looks like one with no
     * Account Name, Branch or Repository at all.
     *
     * Re-deriving placements from that would free every claim on the board
     * over a network blip. So a pass that cannot ask leaves the claims it has
     * where they are, and refreshes only what it did read.
     */
    const canPlace = ["account name", "branch", "repository"]
      .every((name) => (fieldMap[name] || []).length);

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
        updatedAt: t.updated || null,
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
          existing.status = t.status;
          existing.summary = t.summary;
          existing.updatedAt = t.updated || null;
          existing.lastSyncedAt = new Date().toISOString();
          if (!canPlace) return;

          // Still holding — but holding what the ticket says now, not what
          // it said when it was claimed. Branch, Account Name, Repository,
          // Ticket Assignee and the dates all move the claim.
          const placed = placeTicket(t);
          if (placed.error) {
            // Jira has stopped saying where this belongs, so nothing
            // justifies holding an environment in its name. It drops back to
            // a listed ticket carrying the reason, and claims again by itself
            // as soon as the fields say where.
            skipped.push({ key: t.key, reason: placed.error, status: t.status, accountName: t.accountName, branch: t.branch });
            Board.state.tickets = Board.state.tickets.filter((tk) => tk !== existing);
            if (!ignored) record(t);
            return;
          }

          existing.serverId = placed.server.id;
          existing.accountName = t.accountName;
          existing.branch = t.branch;
          existing.repos = placed.repos;
          existing.userIds = placed.userIds;
          existing.rawAssignees = t.ticketAssignees;
          existing.startTime = claimStart(t, existing.startTime);
          existing.endTime = claimEnd(t);
          // `note` and `claimedAt` are the board's own, not Jira's — a
          // person typed the one, and the other records when this ticket
          // first took an environment. Neither is re-derived.
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

      const placed = placeTicket(t);
      if (placed.error) {
        skipped.push({ key: t.key, reason: placed.error, status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        return;
      }

      Board.state.tickets.push({
        id: t.key,
        source: "jira",
        serverId: placed.server.id,
        accountName: t.accountName,
        branch: t.branch,
        repos: placed.repos,
        userIds: placed.userIds,
        rawAssignees: t.ticketAssignees,
        status: t.status,
        summary: t.summary,
        updatedAt: t.updated || null,
        note: null,
        startTime: claimStart(t, null),
        endTime: claimEnd(t),
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
