/**
 * The Jira connection: base URL, account email, and the API token.
 *
 * The token is a secret and lives encrypted (secrets.service.js); base_url and
 * email are not secret and live in the plain jira_connection table, so a
 * `select *` on it is safe to paste into a bug report.
 *
 * `managedByEnv` finally implements what the browser has always been ready
 * for: page-settings.js already reads this flag and already renders a
 * read-only banner and disabled inputs when it is true. The server simply
 * never set it. When JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN are present,
 * this deployment's Jira credentials come from its environment, not from
 * anyone typing into Settings.
 */

const { db } = require("../db/client.js");
const settingsRepo = require("../repositories/settings.repo.js");
const secrets = require("./secrets.service.js");
const audit = require("./audit.service.js");
const { config } = require("../config.js");
const { ForbiddenError } = require("../http/errors.js");

const SECRET_NAME = "jira.api_token";

function envConfigured() {
  return Boolean(config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken);
}

/** The full connection, including the token. For the Jira client only. */
async function read() {
  if (envConfigured()) {
    return {
      baseUrl: config.jiraBaseUrl,
      email: config.jiraEmail,
      apiToken: config.jiraApiToken,
      managedByEnv: true
    };
  }
  const connection = await settingsRepo.getJiraConnection(db);
  const apiToken = await secrets.get(SECRET_NAME);
  return { ...connection, apiToken, managedByEnv: false };
}

/** What the browser may see: never the token. */
async function readPublic() {
  const full = await read();
  return {
    baseUrl: full.baseUrl,
    email: full.email,
    hasToken: Boolean(full.apiToken),
    managedByEnv: full.managedByEnv
  };
}

async function update(ctx, { baseUrl, email, apiToken }) {
  if (envConfigured()) {
    throw new ForbiddenError(
      "Jira credentials come from this deployment's environment variables.",
      { code: "managed-by-env" }
    );
  }

  await settingsRepo.setJiraConnection(db, { baseUrl, email });
  // A blank token field means "keep the existing one" -- matching the
  // previous behaviour exactly, so leaving the field empty in Settings never
  // clears a working connection by accident.
  const tokenChanged = Boolean(apiToken && String(apiToken).trim());
  if (tokenChanged) {
    await secrets.put(SECRET_NAME, String(apiToken).trim(), ctx.user.id);
  }

  await audit.record(db, audit.EVENTS.JIRA_CONFIG_CHANGED, ctx, {
    detail: { baseUrl, email, tokenChanged }
  });

  return readPublic();
}

module.exports = { read, readPublic, update, envConfigured, SECRET_NAME };
