/**
 * The Jira routes: the saved connection, a single ticket lookup, and posting
 * a comment back.
 *
 * The browser never holds the API token — it asks here and this asks Jira.
 * GET /api/jira-config is open to anyone who can see the board (the "Open
 * ticket" button needs the site URL to build a browse link) and answers with
 * the token masked; writing or testing the connection needs `configure`.
 */

const fs = require("fs");
const { sendJson, readBody } = require("../http.js");
const { allows } = require("../access.js");
const Board = require("../board.js");
const { matchRepositoriesToKeys, matchUserIdsByLabels, findServerForTicket } = require("../../shared/data.js");
const {
  JIRA_CONFIG_FILE,
  normalizeBaseUrl, jiraIssuePath, jiraCommentPath, jiraMyselfPath, jiraBrowseUrl,
  loadJiraConfig, jiraConfigured, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
} = require("../jira-client.js");

async function handleJiraConfigGet(res) {
  const config = loadJiraConfig();
  sendJson(res, 200, {
    baseUrl: config ? config.baseUrl : "",
    email: config ? config.email : "",
    hasToken: !!(config && config.apiToken)
  });
}

async function handleJiraConfigPost(req, res) {
  try {
    const body = await readBody(req);
    const existing = loadJiraConfig() || {};
    const next = {
      baseUrl: (body.baseUrl || "").trim(),
      email: (body.email || "").trim(),
      apiToken: body.apiToken ? body.apiToken.trim() : (existing.apiToken || "")
    };
    fs.writeFileSync(JIRA_CONFIG_FILE, JSON.stringify(next, null, 2));
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: "Couldn't save those Jira settings." });
  }
}

async function handleJiraConfigTest(res) {
  const config = loadJiraConfig();
  if (!config) {
    sendJson(res, 200, { ok: false, error: "Fill in site URL, email, and API token first." });
    return;
  }
  try {
    const response = await fetch(jiraMyselfPath(config.baseUrl), {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, error: "Jira rejected those credentials." });
      return;
    }
    if (!response.ok) {
      sendJson(res, 200, { ok: false, error: `Jira returned an unexpected error (${response.status}).` });
      return;
    }
    const data = await response.json();
    sendJson(res, 200, { ok: true, displayName: data.displayName || config.email });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: "Couldn't reach that Jira site." });
  }
}

// Extra ticket fields we auto-fill the booking form from — matched by
// display name (case-insensitive) rather than hardcoded customfield_XXXXX
// IDs, since those IDs are specific to one Jira site's field configuration.
// A name can map to more than one field (recreated across projects, etc.);
// pickFieldValue() picks whichever one actually has a value.

async function handleJiraLookup(key, res) {
  // Always 200 with {ok:false, error} on failure — the client only reads
  // the body, and a non-2xx status here just shows up as console noise for
  // an entirely expected condition (not configured, ticket not found, etc).
  if (!Board.state.settings.jira.enabled) {
    sendJson(res, 200, { ok: false, error: "Jira integration is turned off in Settings." });
    return;
  }
  const config = loadJiraConfig();
  if (!config) {
    sendJson(res, 200, { ok: false, error: "Jira isn't configured yet — add your site URL and API token in Settings." });
    return;
  }

  try {
    const fieldMap = await loadFieldIdMap(config);
    const fieldIds = new Set(["summary", "status", "assignee"]);
    AUTOFILL_FIELD_NAMES.forEach((name) => (fieldMap[name] || []).forEach((id) => fieldIds.add(id)));

    const response = await fetch(jiraIssuePath(config.baseUrl, key, Array.from(fieldIds).join(",")), {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });

    if (response.status === 404) {
      sendJson(res, 200, { ok: false, error: `${key} wasn't found in Jira.` });
      return;
    }
    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, error: "Jira rejected the configured credentials." });
      return;
    }
    if (!response.ok) {
      sendJson(res, 200, { ok: false, error: `Jira returned an unexpected error (${response.status}).` });
      return;
    }

    const data = await response.json();
    sendJson(res, 200, {
      ok: true,
      key: data.key,
      summary: data.fields.summary || "",
      status: data.fields.status ? data.fields.status.name : "Unknown",
      statusCategory: data.fields.status ? data.fields.status.statusCategory.key : "new",
      assignee: data.fields.assignee ? data.fields.assignee.displayName : null,
      url: jiraBrowseUrl(config.baseUrl, data.key),
      ticketAssignees: pickFieldValue(data.fields, fieldMap["ticket assignee"]) || [],
      accountName: firstOf(pickFieldValue(data.fields, fieldMap["account name"])),
      branch: firstOf(pickFieldValue(data.fields, fieldMap["branch"])),
      repository: pickFieldValue(data.fields, fieldMap["repository"]) || [],
      startDate: pickFieldValue(data.fields, fieldMap["start date"]),
      dueDate: pickFieldValue(data.fields, fieldMap["due date"])
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: "Couldn't reach Jira from this server." });
  }
}

async function handleJiraComment(req, res) {
  try {
    const { key, comment } = await readBody(req);
    if (!jiraConfigured() || !key || !comment) {
      sendJson(res, 200, { ok: false, error: "Jira isn't configured, or nothing to comment on." });
      return;
    }
    const config = loadJiraConfig();
    const response = await fetch(jiraCommentPath(config.baseUrl, key), {
      method: "POST",
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] }
      })
    });
    sendJson(res, 200, { ok: response.ok });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: "Couldn't post that comment to Jira." });
  }
}

/**
 * Returns true when it recognised the path and has answered. Ordered so the
 * fixed paths are checked before the ticket-key pattern.
 */
function route(req, res, url, user, jobs) {
  if (url === "/api/jira-config" && req.method === "GET") {
    if (!allows(res, user, "view")) return true;
    handleJiraConfigGet(res);
    return true;
  }
  if (url === "/api/jira-config" && req.method === "POST") {
    if (!allows(res, user, "configure")) return true;
    handleJiraConfigPost(req, res);
    return true;
  }
  if (url === "/api/jira-config/test" && req.method === "POST") {
    if (!allows(res, user, "configure")) return true;
    handleJiraConfigTest(res);
    return true;
  }
  if (url === "/api/jira/comment" && req.method === "POST") {
    if (!allows(res, user, "claim")) return true;
    handleJiraComment(req, res);
    return true;
  }

  // Refreshing what the server already polls on its own changes nothing a
  // viewer couldn't already see — it only asks for it sooner.
  if (url === "/api/jira/sync-now" && req.method === "POST") {
    if (!allows(res, user, "view")) return true;
    jobs.runJiraSync(true)
      .then((result) => sendJson(res, 200, result))
      .catch(() => sendJson(res, 200, { ok: false, reason: "error" }));
    return true;
  }

  const jiraMatch = url.match(/^\/api\/jira\/([A-Za-z][A-Za-z0-9]*-\d+)$/);
  if (jiraMatch && req.method === "GET") {
    if (!allows(res, user, "view")) return true;
    handleJiraLookup(jiraMatch[1].toUpperCase(), res);
    return true;
  }

  return false;
}

module.exports = { route };
