/**
 * Validation rules, run by both sides.
 *
 * The browser needs these synchronously: every form in this application calls a
 * State mutator and reads `{ ok, errors }` back on the same line, and turning
 * that into a round-trip would mean rewriting every modal. The server needs the
 * same rules because a browser is not a place to enforce anything.
 *
 * So they live here, in the one module both runtimes load -- the same trick
 * shared/data.js already uses for the role table and the Jira matchers. Two
 * callers, one implementation, and no way for them to drift apart.
 *
 * Every function is pure: it takes the board it should judge against, returns a
 * list of human-readable errors, and changes nothing. An empty list means the
 * input is acceptable.
 */

/* global window */

const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function text(value) {
  return String(value == null ? "" : value).trim();
}

function sameText(a, b) {
  return text(a).toLowerCase() === text(b).toLowerCase();
}

/**
 * "[BE]_Sem, [QA]_Sem" from a text field, or an array from anywhere else,
 * normalised to the list the Jira matcher wants. Blank means "use the display
 * name", which is what the field did before it existed.
 */
function normalizeJiraNames(value, fallbackName) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const names = [];
  list.map((n) => text(n)).filter(Boolean).forEach((n) => {
    if (!names.some((seen) => seen.toLowerCase() === n.toLowerCase())) names.push(n);
  });
  if (names.length) return names;
  const fallback = text(fallbackName);
  return fallback ? [fallback] : [];
}

/** The id an account gets when one is not supplied: a slug of its name. */
function slugAccountId(displayName) {
  return text(displayName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * The labels a person answers to. Falls back to their display name, matching
 * userJiraNames() in shared/data.js -- resolved through the global when this
 * module is loaded in the browser, and through require() on the server.
 */
function labelsFor(person) {
  if (typeof module !== "undefined" && module.exports) {
    return require("./data.js").userJiraNames(person);
  }
  return window.userJiraNames(person);
}

// ----------------------------------------------------------------- claims --

function validateClaim(board, { repos, userIds, jiraTicket, startTime, endTime }) {
  const errors = [];

  if (!repos || !repos.length) errors.push("Select at least one repo to claim.");
  if (!userIds || !userIds.length) errors.push("At least one user is required.");

  const requireTicket = board.settings && board.settings.jira
    ? board.settings.jira.requireTicket
    : false;

  if (jiraTicket || requireTicket) {
    if (!jiraTicket || !JIRA_KEY_PATTERN.test(text(jiraTicket))) {
      errors.push("Jira ticket must look like PROJ-1234.");
    }
  }

  if (!startTime || !endTime) {
    errors.push("Start and end time are required.");
  } else if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
    errors.push("End time must be after start time.");
  }

  return errors;
}

// ----------------------------------------------------------- environments --

/**
 * @param serverId  the environment being edited, or null when adding one.
 */
function validateServer(board, serverId, { name, accountId }) {
  const errors = [];
  const nextName = text(name);
  const account = (board.accounts || []).find((a) => a.id === accountId) || null;

  if (!nextName) errors.push("Environment name is required.");
  if (!account) errors.push("Pick an account for this environment.");

  if (account && (board.servers || []).some((s) =>
    s.id !== serverId && s.accountId === account.id && sameText(s.name, nextName)
  )) {
    errors.push(`${account.displayName} already has an environment called "${nextName}".`);
  }

  return errors;
}

// ---------------------------------------------------------------- accounts --

function validateAccount(board, accountId, { id, displayName, repositories }) {
  const errors = [];
  const nextName = text(displayName);
  const nextId = text(id) || slugAccountId(nextName);
  const nextRepos = [...new Set((repositories || []).map((r) => text(r)).filter(Boolean))];

  if (!nextName) errors.push("Display name is required.");
  // The id is derived, so a blank one only ever means the name had no letters
  // or digits to slug -- say that, rather than naming a field nobody filled in.
  if (nextName && !nextId) errors.push("Display name needs at least one letter or number.");
  if (!nextRepos.length) errors.push("At least one repository is required.");

  // A duplicate name almost always slugs to a duplicate id too -- report the
  // one the person actually typed, not both.
  if (nextName && (board.accounts || []).some((a) =>
    a.id !== accountId && sameText(a.displayName, nextName)
  )) {
    errors.push(`Another account is already called "${nextName}".`);
  } else if (nextId && (board.accounts || []).some((a) => a.id !== accountId && a.id === nextId)) {
    errors.push(`Account id "${nextId}" is already taken.`);
  }

  return errors;
}

// --------------------------------------------------------------- directory --

/**
 * Two people answering to the same Jira label makes matching a coin toss, so
 * the clash is refused rather than resolved silently at sync time.
 */
function jiraNameClashes(board, names, exceptUserId) {
  const errors = [];
  names.forEach((name) => {
    const owner = (board.users || []).find((u) =>
      u.id !== exceptUserId && labelsFor(u).some((n) => sameText(n, name))
    );
    if (!owner) return;
    errors.push(sameText(owner.name, name)
      ? `"${name}" belongs to a second user of the same name — remove the duplicate first.`
      : `"${name}" is already a Jira name for ${owner.name}.`);
  });
  return errors;
}

function validateDirectoryUser(board, userId, { name, role, jiraNames }) {
  const errors = [];
  const nextName = text(name);
  const nextRole = text(role);
  const nextJiraNames = normalizeJiraNames(jiraNames, nextName);

  if (!nextName) errors.push("Display name is required.");
  if (!nextRole) errors.push("Role is required.");

  if ((board.users || []).some((u) => u.id !== userId && sameText(u.name, nextName))) {
    errors.push(`Another user is already called "${nextName}".`);
  }

  errors.push(...jiraNameClashes(board, nextJiraNames, userId));
  return errors;
}

// ---------------------------------------------------------------- settings --

const ON_EXPIRY_VALUES = ["remind", "remind-flag", "auto-release"];

function validateSettings(patch) {
  const errors = [];

  if (patch.defaultBookingHours !== undefined) {
    const hours = Number(patch.defaultBookingHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
      errors.push("Default booking length must be between 1 and 720 hours.");
    }
  }

  if (patch.onExpiry !== undefined && !ON_EXPIRY_VALUES.includes(patch.onExpiry)) {
    errors.push("Pick what happens when a booking expires.");
  }

  if (patch.jira && patch.jira.pollIntervalMinutes !== undefined) {
    const minutes = Number(patch.jira.pollIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      errors.push("Jira poll interval must be between 1 and 1440 minutes.");
    }
  }

  return errors;
}

const RULES = {
  JIRA_KEY_PATTERN, ON_EXPIRY_VALUES,
  normalizeJiraNames, slugAccountId,
  validateClaim, validateServer, validateAccount,
  validateDirectoryUser, jiraNameClashes, validateSettings
};

// Loaded by the server with require(), and by the browser as a plain script
// where these become globals -- the same dual form shared/data.js uses.
if (typeof module !== "undefined" && module.exports) {
  module.exports = RULES;
} else if (typeof window !== "undefined") {
  Object.assign(window, RULES);
  window.Rules = RULES;
}
