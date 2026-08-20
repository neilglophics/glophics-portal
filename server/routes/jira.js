/**
 * The Jira routes: the saved connection, a single ticket lookup, posting a
 * comment back, and the manual sync trigger.
 *
 * The browser never holds the API token -- it asks here, and this asks Jira.
 * Several of these answer HTTP 200 with `{ok:false, error}` on a failure that
 * is expected and routine (Jira not configured, a ticket not found) rather
 * than a 4xx/5xx -- that choice is unchanged from the previous implementation,
 * and preserved here so the browser's handling of these specific endpoints
 * needs no update.
 */

const jiraConfigService = require("../services/jira-config.service.js");
const jiraSyncService = require("../services/jira-sync.service.js");
const {
  jiraIssuePath, jiraCommentPath, jiraMyselfPath, jiraBrowseUrl,
  jiraAuthHeader, AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
} = require("../jira-client.js");
const settingsService = require("../services/settings.service.js");

async function getConfig() {
  return jiraConfigService.readPublic();
}

async function updateConfig(ctx) {
  const body = await ctx.readBody();
  return jiraConfigService.update(ctx, body);
}

async function testConfig() {
  const config = await jiraConfigService.read();
  if (!config.baseUrl || !config.email || !config.apiToken) {
    return { ok: false, error: "Fill in site URL, email, and API token first." };
  }
  try {
    const response = await fetch(jiraMyselfPath(config.baseUrl), {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "Jira rejected those credentials." };
    }
    if (!response.ok) {
      return { ok: false, error: `Jira returned an unexpected error (${response.status}).` };
    }
    const data = await response.json();
    return { ok: true, displayName: data.displayName || config.email };
  } catch (err) {
    return { ok: false, error: "Couldn't reach that Jira site." };
  }
}

const JIRA_KEY_ROUTE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * A single-ticket lookup. No client code currently calls this route -- it was
 * left over from a removed autofill flow in the previous implementation --
 * but it is a real, working endpoint and is kept working rather than removed,
 * since removing a route someone might depend on is not this rewrite's call
 * to make silently.
 */
async function lookup(ctx) {
  const key = String(ctx.params.key || "").toUpperCase();
  if (!JIRA_KEY_ROUTE.test(key)) {
    return { ok: false, error: "That doesn't look like a Jira ticket key." };
  }

  const settings = await settingsService.get();
  if (!settings.jira.enabled) {
    return { ok: false, error: "Jira integration is turned off in Settings." };
  }
  const config = await jiraConfigService.read();
  if (!config.apiToken) {
    return { ok: false, error: "Jira isn't configured yet — add your site URL and API token in Settings." };
  }

  try {
    const fieldMap = await loadFieldIdMap(config);
    const fieldIds = new Set(["summary", "status", "assignee"]);
    AUTOFILL_FIELD_NAMES.forEach((name) => (fieldMap[name] || []).forEach((id) => fieldIds.add(id)));

    const response = await fetch(jiraIssuePath(config.baseUrl, key, Array.from(fieldIds).join(",")), {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });

    if (response.status === 404) return { ok: false, error: `${key} wasn't found in Jira.` };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "Jira rejected the configured credentials." };
    }
    if (!response.ok) return { ok: false, error: `Jira returned an unexpected error (${response.status}).` };

    const data = await response.json();
    return {
      ok: true,
      key: data.key,
      summary: data.fields.summary || "",
      status: data.fields.status ? data.fields.status.name : "Unknown",
      statusCategory: data.fields.status ? data.fields.status.statusCategory.key : "new",
      assignee: data.fields.assignee ? data.fields.assignee.displayName : null,
      url: jiraBrowseUrl(config.baseUrl, data.key),
      ticketAssignees: pickFieldValue(data.fields, fieldMap["ticket assignee"]) || [],
      accountName: firstOf(pickFieldValue(data.fields, fieldMap["account name"])),
      branch: firstOf(pickFieldValue(data.fields, fieldMap.branch)),
      repository: pickFieldValue(data.fields, fieldMap.repository) || [],
      startDate: pickFieldValue(data.fields, fieldMap["start date"]),
      dueDate: pickFieldValue(data.fields, fieldMap["due date"])
    };
  } catch (err) {
    return { ok: false, error: "Couldn't reach Jira from this server." };
  }
}

/** No UI caller today, kept working for the same reason as lookup() above. */
async function comment(ctx) {
  const body = await ctx.readBody();
  const config = await jiraConfigService.read();
  const settings = await settingsService.get();
  if (!settings.jira.enabled || !config.apiToken || !body.key || !body.comment) {
    return { ok: false, error: "Jira isn't configured, or nothing to comment on." };
  }
  try {
    const response = await fetch(jiraCommentPath(config.baseUrl, body.key), {
      method: "POST",
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: body.comment }] }] }
      })
    });
    return { ok: response.ok };
  } catch (err) {
    return { ok: false, error: "Couldn't post that comment to Jira." };
  }
}

/** Refreshing what the server already polls on its own changes nothing a
 *  viewer couldn't already see -- it only asks for it sooner. */
async function syncNow() {
  try {
    return await jiraSyncService.runJiraSync({ force: true });
  } catch (err) {
    return { ok: false, reason: "error" };
  }
}

module.exports = { getConfig, updateConfig, testConfig, lookup, comment, syncNow };
