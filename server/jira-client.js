/**
 * Talking to Jira. Credentials, URLs, and the field-id lookup — everything
 * that needs the API token, and nothing that answers an http request.
 *
 * The token lives in config/jira-config.json and is read fresh on every call,
 * so editing that file by hand takes effect without a restart. It is never
 * part of the board, so it is never broadcast to a browser tab; the config
 * route masks it even from the people allowed to change it.
 */

const fs = require("fs");
const path = require("path");
const { CONFIG_DIR } = require("./paths.js");
const Board = require("./board.js");

const JIRA_CONFIG_FILE = path.join(CONFIG_DIR, "jira-config.json");

// handleJiraConfigPost writes here, and on a fresh checkout nothing has
// created it yet.
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Accept a saved baseUrl with or without a protocol (people paste bare
// domains like "company.atlassian.net") — fetch() throws on a protocol-less
// URL, which otherwise surfaces as a confusing "couldn't reach" error.
function normalizeBaseUrl(base) {
  const trimmed = (base || "").trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const jiraIssuePath = (base, key, fields) => `${normalizeBaseUrl(base)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields || "summary,status,assignee"}`;
const jiraCommentPath = (base, key) => `${normalizeBaseUrl(base)}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
const jiraMyselfPath = (base) => `${normalizeBaseUrl(base)}/rest/api/3/myself`;
const jiraBrowseUrl = (base, key) => `${normalizeBaseUrl(base)}/browse/${key}`;

// Never part of `state`, so never broadcast to browser tabs over SSE.
// Read fresh each call so editing jira-config.json by hand still works.

function loadJiraConfig() {
  if (!fs.existsSync(JIRA_CONFIG_FILE)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(JIRA_CONFIG_FILE, "utf8"));
    if (!config.baseUrl || !config.email || !config.apiToken) return null;
    return config;
  } catch (err) {
    return null;
  }
}

function jiraConfigured() {
  const config = loadJiraConfig();
  return !!config && Board.state.settings.jira.enabled;
}

function jiraAuthHeader(config) {
  return "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
}

const AUTOFILL_FIELD_NAMES = ["ticket assignee", "account name", "branch", "repository", "start date", "due date"];

let fieldIdCache = null;
let fieldIdCacheAt = 0;
const FIELD_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadFieldIdMap(config) {
  if (fieldIdCache && Date.now() - fieldIdCacheAt < FIELD_CACHE_TTL_MS) return fieldIdCache;
  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/rest/api/3/field`, {
      headers: { Authorization: jiraAuthHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return fieldIdCache || {};
    const fields = await response.json();
    const map = {};
    fields.forEach((f) => {
      const key = (f.name || "").toLowerCase();
      if (!map[key]) map[key] = [];
      map[key].push(f.id);
    });
    fieldIdCache = map;
    fieldIdCacheAt = Date.now();
    return map;
  } catch (err) {
    return fieldIdCache || {};
  }
}

function pickFieldValue(issueFields, ids) {
  for (const id of ids || []) {
    const v = issueFields[id];
    const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (!empty) return v;
  }
  return null;
}

// Single-value "labels" fields (Account Name, Branch) still come back as a
// one-element array from Jira's API — unwrap to a plain value.
function firstOf(v) {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}


module.exports = {
  JIRA_CONFIG_FILE,
  normalizeBaseUrl, jiraIssuePath, jiraCommentPath, jiraMyselfPath, jiraBrowseUrl,
  loadJiraConfig, jiraConfigured, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
};
