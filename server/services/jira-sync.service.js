/**
 * Pulling occupancy from Jira without anyone asking.
 *
 * This reproduces the claim state machine from the previous implementation
 * exactly -- claims are sticky (repos/serverId/userIds never move mid-claim,
 * only display fields refresh), a terminal status always frees regardless of
 * configuration, and the JQL's `OR key IN (held keys)` clause is load-bearing:
 * without it, a ticket that reaches DONE (both a releasing status and an
 * ignored one) would never be asked about again and its environment would stay
 * held forever.
 *
 * What changes is the cost of an idle pass. The previous version rebuilt two
 * arrays from scratch and rebroadcast the entire board every twenty seconds
 * whether anything had moved or not. Here, each derived row carries a content
 * hash; unchanged rows are not written, and nothing is broadcast unless
 * something changed. Claims still get exactly the same sticky treatment.
 */

const { db } = require("../db/client.js");
const claimsRepo = require("../repositories/claims.repo.js");
const serversRepo = require("../repositories/servers.repo.js");
const accountsRepo = require("../repositories/accounts.repo.js");
const directoryRepo = require("../repositories/directory-users.repo.js");
const settingsRepo = require("../repositories/settings.repo.js");
const jiraIssuesRepo = require("../repositories/jira-issues.repo.js");
const syncStateRepo = require("../repositories/sync-state.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS, MAX_DELTA_ENTITIES } = require("../realtime/events.js");
const {
  matchRepositoriesToKeys, matchUserIdsByLabels, findServerForTicket,
  statusIn, statusFrees, statusIsTerminal
} = require("../../shared/data.js");
const {
  normalizeBaseUrl, loadJiraConfig, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
} = require("../jira-client.js");

const JIRA_SYNC_WINDOW = "updated >= -30d";
const JIRA_SYNC_PAGE_SIZE = 100;
const JIRA_SYNC_MAX_PAGES = 5;
// How long a full sweep's results stay valid before another one is due. This
// is what garbage-collects jira_issues/jira_skipped rows an incremental pass
// legitimately never revisits.
const FULL_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Overlap absorbs clock skew between this process and Jira, and Jira's own
// indexing lag -- an issue updated a few seconds before the last sync
// completed should not be missed by a window that starts exactly then.
const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

const jqlText = (value) => "\"" + String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

function jqlDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @param heldKeys  Jira keys currently holding an environment. Asked for by
 *                  key regardless of the window, so an active claim is never
 *                  silently dropped from the results that keep it alive.
 */
function buildSyncJql(jira, heldKeys, { mode, since }) {
  const ignored = (jira.ignoredStatuses || []).filter(Boolean);
  const base = mode === "full" ? JIRA_SYNC_WINDOW : `updated >= "${jqlDate(since)}"`;
  const window = ignored.length
    ? `(${base} AND status NOT IN (${ignored.map(jqlText).join(", ")}))`
    : base;
  const where = heldKeys.length ? `${window} OR key IN (${heldKeys.join(", ")})` : window;
  return `${where} ORDER BY updated DESC`;
}

async function fetchJiraSearchIssues(config, fieldIds, query) {
  const jql = encodeURIComponent(query);
  const fields = encodeURIComponent(Array.from(fieldIds).join(","));
  const base = normalizeBaseUrl(config.baseUrl);
  const issues = [];
  let token = null;

  for (let page = 0; page < JIRA_SYNC_MAX_PAGES; page += 1) {
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
    ticketAssignees: pickFieldValue(f, fieldMap["ticket assignee"]) || [],
    accountName: firstOf(pickFieldValue(f, fieldMap["account name"])),
    branch: firstOf(pickFieldValue(f, fieldMap.branch)),
    repository: pickFieldValue(f, fieldMap.repository) || [],
    startDate: pickFieldValue(f, fieldMap["start date"]),
    dueDate: pickFieldValue(f, fieldMap["due date"])
  };
}

async function runJiraSync({ force = false } = {}) {
  const settings = await settingsRepo.get(db);
  if (!settings.jira.enabled) return { ok: false, reason: "disabled" };
  if (!force && !settings.jira.autoSync) return { ok: false, reason: "auto-sync-off" };

  const config = await loadJiraConfig();
  if (!config) return { ok: false, reason: "not-configured" };

  const syncState = await syncStateRepo.get(db);
  const intervalMs = Math.max(1, settings.jira.pollIntervalMinutes || 1) * 60_000;
  const lastAt = syncState.lastJiraSyncAt ? new Date(syncState.lastJiraSyncAt).getTime() : 0;
  if (!force && Date.now() - lastAt < intervalMs) return { ok: false, reason: "throttled" };

  const lastSweepAt = syncState.lastFullSweepAt ? new Date(syncState.lastFullSweepAt).getTime() : 0;
  const mode = force || Date.now() - lastSweepAt >= FULL_SWEEP_INTERVAL_MS ? "full" : "incremental";
  const since = new Date(lastAt - INCREMENTAL_OVERLAP_MS);

  const runId = await jiraIssuesRepo.startRun(db, mode);

  try {
    const fieldMap = await loadFieldIdMap(config);
    const fieldIds = new Set(["summary", "status"]);
    AUTOFILL_FIELD_NAMES.forEach((name) => (fieldMap[name] || []).forEach((id) => fieldIds.add(id)));

    const heldKeys = await claimsRepo.listJiraKeysHeld(db);
    const jql = buildSyncJql(settings.jira, heldKeys.filter((k) => JIRA_KEY.test(k)), { mode, since });
    const issues = await fetchJiraSearchIssues(config, fieldIds, jql);

    const servers = await serversRepo.list(db);
    const accounts = await accountsRepo.list(db);
    const users = await directoryRepo.list(db);

    const skipped = [];
    const onBoard = [];
    const claimEvents = [];

    const record = (t) => {
      const { server } = findServerForTicket(t, accounts, servers);
      const repoCheck = server
        ? matchRepositoriesToKeys(t.repository, Object.keys(server.repos))
        : { matched: [] };
      onBoard.push({
        key: t.key,
        serverId: server ? server.id : null,
        accountName: t.accountName,
        branch: t.branch,
        repos: repoCheck.matched,
        userIds: matchUserIdsByLabels(t.ticketAssignees, users).matched,
        rawAssignees: t.ticketAssignees,
        status: t.status,
        summary: t.summary,
        startTime: t.startDate ? new Date(`${t.startDate}T09:00`).toISOString() : null,
        endTime: t.dueDate ? new Date(`${t.dueDate}T18:00`).toISOString() : null
      });
    };

    for (const issue of issues) {
      const t = extractTicketFields(issue, fieldMap);
      const existing = await claimsRepo.findById(db, t.key);
      const ignored = statusIn(settings.jira.ignoredStatuses, t.status);

      if (existing && existing.source === "jira") {
        if (!statusFrees(settings.jira, t.status)) {
          const { changed } = await claimsRepo.touchFromJira(db, t.key, {
            status: t.status, summary: t.summary
          });
          if (changed) claimEvents.push({ type: "updated", id: t.key });
          continue;
        }
        await claimsRepo.remove(db, t.key);
        claimEvents.push({ type: "deleted", id: t.key });
        if (!ignored) record(t);
        continue;
      }

      if (ignored) continue;

      if (statusIsTerminal(t.status) || !statusIn(settings.jira.occupyingStatuses, t.status)) {
        record(t);
        continue;
      }

      const found = findServerForTicket(t, accounts, servers);
      if (found.error) {
        skipped.push({ key: t.key, reason: found.error, status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        continue;
      }
      if (!t.repository || !t.repository.length) {
        skipped.push({ key: t.key, reason: "Repository field is empty.", status: t.status, accountName: t.accountName, branch: t.branch });
        record(t);
        continue;
      }
      const repoCheck = matchRepositoriesToKeys(t.repository, Object.keys(found.server.repos));
      if (!repoCheck.matched.length) {
        const repoLabel = t.repository.join(", ");
        skipped.push({
          key: t.key,
          reason: `Repository field ("${repoLabel}") doesn't match any repo on ${found.server.name}.`,
          status: t.status, accountName: t.accountName, branch: t.branch
        });
        record(t);
        continue;
      }

      const userMatch = matchUserIdsByLabels(t.ticketAssignees, users);
      const startTime = t.startDate ? new Date(`${t.startDate}T09:00`).toISOString() : new Date().toISOString();
      const endTime = t.dueDate ? new Date(`${t.dueDate}T18:00`).toISOString() : null;

      await claimsRepo.insert(db, {
        id: t.key, source: "jira", serverId: found.server.id,
        accountName: t.accountName, branch: t.branch,
        repos: repoCheck.matched, userIds: userMatch.matched, rawAssignees: t.ticketAssignees,
        status: t.status, summary: t.summary, note: null,
        startTime, endTime, claimedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString()
      });
      claimEvents.push({ type: "created", id: t.key });
    }

    const issueHashes = await jiraIssuesRepo.issueHashes(db);
    const skippedHashes = await jiraIssuesRepo.skippedHashes(db);
    const changedIssueKeys = await jiraIssuesRepo.upsertIssues(db, onBoard, runId, issueHashes);
    const changedSkippedKeys = await jiraIssuesRepo.upsertSkipped(db, skipped, runId, skippedHashes);

    let removedIssueKeys = [];
    let removedSkippedKeys = [];
    if (mode === "full") {
      removedIssueKeys = await jiraIssuesRepo.listStaleIssueKeys(db, runId);
      removedSkippedKeys = await jiraIssuesRepo.listStaleSkippedKeys(db, runId);
      // A guard against a JQL or matching bug quietly emptying the table: an
      // incremental pass never reaches this branch, so this only fires on the
      // scheduled full sweep, and it is the one place that could delete
      // everything if the query came back suspiciously empty.
      const totalBefore = await jiraIssuesRepo.countIssues(db);
      if (totalBefore > 0 && removedIssueKeys.length / totalBefore > 0.5) {
        console.error(
          `[jira-sync] full sweep would remove ${removedIssueKeys.length}/${totalBefore} issues; ` +
          "refusing, this looks like a bad response rather than a real change."
        );
        removedIssueKeys = [];
      } else {
        await jiraIssuesRepo.deleteIssues(db, removedIssueKeys);
      }
      await jiraIssuesRepo.deleteSkipped(db, removedSkippedKeys);
      await syncStateRepo.update(db, { lastFullSweepAt: new Date() });
    }

    const now = new Date();
    await syncStateRepo.update(db, { lastJiraSyncAt: now, lastJiraError: null });
    await jiraIssuesRepo.finishRun(db, runId, {
      issueCount: issues.length,
      changedCount: changedIssueKeys.length + changedSkippedKeys.length + claimEvents.length,
      skippedCount: skipped.length
    });

    await broadcastChanges({
      now, changedIssueKeys, removedIssueKeys, changedSkippedKeys, removedSkippedKeys, claimEvents
    });

    return { ok: true, issueCount: issues.length, skippedCount: skipped.length, mode };
  } catch (err) {
    await syncStateRepo.update(db, { lastJiraError: err.message || "Jira sync failed." });
    await jiraIssuesRepo.finishRun(db, runId, { error: err.message || "Jira sync failed." });
    return { ok: false, reason: "error", error: err.message };
  }
}

/**
 * Tells the browsers what happened, in the cheapest form that is still
 * correct: nothing changed -> a heartbeat so "synced Ns ago" stays live;
 * a little changed -> the exact rows; too much changed -> "go refetch".
 */
async function broadcastChanges({ now, changedIssueKeys, removedIssueKeys, changedSkippedKeys, removedSkippedKeys, claimEvents }) {
  const totalChanged = changedIssueKeys.length + removedIssueKeys.length
    + changedSkippedKeys.length + removedSkippedKeys.length + claimEvents.length;

  if (totalChanged === 0) {
    await bus.emit(EVENTS.JIRA_HEARTBEAT, { lastJiraSyncAt: now.toISOString() });
    return;
  }

  if (totalChanged > MAX_DELTA_ENTITIES) {
    await bus.emit(EVENTS.INVALIDATE, { reason: "jira-sync" });
    return;
  }

  const upsertedIssues = await jiraIssuesRepo.findIssuesByKeys(db, changedIssueKeys);
  const upsertedSkipped = await jiraIssuesRepo.findSkippedByKeys(db, changedSkippedKeys);

  await bus.emit(EVENTS.JIRA_SYNCED, {
    lastJiraSyncAt: now.toISOString(),
    issues: { upserted: upsertedIssues, removed: removedIssueKeys },
    skipped: { upserted: upsertedSkipped, removed: removedSkippedKeys }
  });

  for (const event of claimEvents) {
    if (event.type === "deleted") {
      await bus.emit(EVENTS.CLAIM_DELETED, { id: event.id });
    } else {
      const claim = await claimsRepo.findById(db, event.id);
      if (claim) {
        await bus.emit(event.type === "created" ? EVENTS.CLAIM_CREATED : EVENTS.CLAIM_UPDATED, claim);
      }
    }
  }
}

module.exports = { runJiraSync, buildSyncJql, FULL_SWEEP_INTERVAL_MS };
