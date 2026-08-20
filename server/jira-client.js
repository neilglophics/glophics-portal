/**
 * Talking to Jira. URL builders, the auth header, and the field-id lookup --
 * everything that needs the API token, and nothing that answers an http
 * request.
 *
 * The token used to live in config/jira-config.json, read fresh off disk on
 * every call. It now comes from jira-config.service.js, which resolves it from
 * the environment or from the encrypted `secrets` table -- never from a plain
 * file, and never part of the board, so it is never broadcast to a browser tab.
 */

const jiraConfigService = require("./services/jira-config.service.js");

// Accept a saved baseUrl with or without a protocol (people paste bare domains
// like "company.atlassian.net") -- fetch() throws on a protocol-less URL,
// which otherwise surfaces as a confusing "couldn't reach" error.
function normalizeBaseUrl(base) {
  const trimmed = (base || "").trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const jiraIssuePath = (base, key, fields) =>
  `${normalizeBaseUrl(base)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields || "summary,status,assignee"}`;
const jiraCommentPath = (base, key) => `${normalizeBaseUrl(base)}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
const jiraMyselfPath = (base) => `${normalizeBaseUrl(base)}/rest/api/3/myself`;
const jiraBrowseUrl = (base, key) => `${normalizeBaseUrl(base)}/browse/${key}`;
const jiraSearchPath = (base) => `${normalizeBaseUrl(base)}/rest/api/3/search/jql`;
const jiraFieldPath = (base) => `${normalizeBaseUrl(base)}/rest/api/3/field`;

async function loadJiraConfig() {
  const config = await jiraConfigService.read();
  if (!config.baseUrl || !config.email || !config.apiToken) return null;
  return config;
}

async function jiraConfigured(settings) {
  const config = await loadJiraConfig();
  return Boolean(config) && Boolean(settings && settings.jira && settings.jira.enabled);
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
    const response = await fetch(jiraFieldPath(config.baseUrl), {
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
// one-element array from Jira's API -- unwrap to a plain value.
function firstOf(v) {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

module.exports = {
  normalizeBaseUrl, jiraIssuePath, jiraCommentPath, jiraMyselfPath, jiraBrowseUrl,
  jiraSearchPath, jiraFieldPath,
  loadJiraConfig, jiraConfigured, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
};
