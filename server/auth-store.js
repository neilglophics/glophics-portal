/**
 * Sign-in credentials and sessions. Server-side only.
 *
 * Credentials live in config/auth.json — outside every root the static
 * handler serves — and are *never* part of `state`, so they are never
 * written into the board's own files and never
 * broadcast to a browser tab over SSE. The only shape that ever reaches a
 * client is publicUser(), which carries no salt and no hash.
 *
 * An account does not describe the person behind it beyond a display name.
 * Who they are on the board — their job role, and the Jira "Ticket Assignee"
 * labels their tickets carry — is the directory's business (shared-state.json
 * → users), and an account points at one directory person by id. So a person
 * is described in one place, and an account and a ticket cannot end up
 * disagreeing about which label belongs to whom.
 *
 * Passwords are scrypt-hashed with a per-user random salt and compared with
 * a timing-safe equal. No dependencies: everything here is node:crypto.
 *
 * Roles come from shared/data.js (AUTH_ROLES) — the same list the browser
 * reads, so what the UI hides and what the server refuses cannot drift.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AUTH_ROLES, roleCan, isValidRole, userJiraNames, matchUserIdsByLabels } = require("../shared/data.js");

const { CONFIG_DIR } = require("./paths.js");

// Not beside this file: config/ is outside every root the static handler can
// read, so the hashes and live session tokens below are unreachable over http
// by layout rather than by an extension allowlist.
const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week, then sign in again
const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// What the first super admin gets when ADMIN_USERNAME / ADMIN_PASSWORD are
// not set. Documented in the README and printed on every start while it is
// still in use — which is the point of a default, and equally the risk:
// anyone who has seen this repo knows it. Change it once you are signed in,
// or set the env vars before the first run and this is never used.
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin1234";

// Failed sign-ins are counted per username in memory. Enough to make
// guessing a password over the network impractical without needing a store.
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS = 10 * 60 * 1000;
const failures = new Map();   // username -> { count, until }

// ---------- file ----------

function emptyStore() {
  return { users: [], sessions: {} };
}

function load() {
  if (!fs.existsSync(AUTH_FILE)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {};
    return parsed;
  } catch (err) {
    // A corrupt file must not hand out access — start closed and let the
    // seed below mint a fresh super admin with a password on the console.
    return emptyStore();
  }
}

function save(store) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------- the people directory ----------

/**
 * The directory an account links into lives in `state`, which this file
 * deliberately cannot see — it holds credentials, and must not grow a way
 * to reach the board. So server/index.js injects a reader for it at boot.
 *
 * Until it does, every account reads as unlinked rather than throwing: a
 * script that requires this file on its own still works, it just sees no
 * Jira names.
 */
let readDirectory = () => [];

function useDirectory(getUsers) {
  readDirectory = typeof getUsers === "function" ? getUsers : () => [];
}

function directoryPerson(id) {
  if (!id) return null;
  return readDirectory().find((u) => u.id === id) || null;
}

// Blank, whitespace, or a form field left on "Nobody" all mean unlinked.
function normalizeLink(value) {
  const id = String(value == null ? "" : value).trim();
  return id || null;
}

// ---------- passwords ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
}

function newCredentials(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function passwordMatches(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const attempt = Buffer.from(hashPassword(password, user.salt), "hex");
  const stored = Buffer.from(user.hash, "hex");
  if (attempt.length !== stored.length) return false;
  return crypto.timingSafeEqual(attempt, stored);
}

// ---------- shapes ----------

/**
 * The only user shape that ever leaves this process.
 *
 * `jiraNames` is not stored on an account — it is read through the link, so
 * it is whatever the directory says right now. Fixing a mistyped label in
 * the directory fixes what My tickets shows, with no second edit here.
 *
 * A link whose person has since been removed from the directory reads as
 * unlinked rather than as an error: the account still signs in, it simply
 * has no Jira names until somebody points it at a person again.
 */
function publicUser(user) {
  if (!user) return null;
  const person = directoryPerson(user.directoryUserId);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    directoryUserId: person ? person.id : null,
    jiraNames: person ? userJiraNames(person) : [],
    active: user.active !== false,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null
  };
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateCredentials(store, { username, displayName, role, password, directoryUserId }, existingId) {
  const errors = [];
  const name = normalizeUsername(username);

  if (!name) {
    errors.push("Username is required.");
  } else if (!USERNAME_PATTERN.test(name)) {
    errors.push("Username must be 3-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.");
  } else if (store.users.some((u) => u.id !== existingId && u.username === name)) {
    errors.push(`The username "${name}" is already taken.`);
  }

  if (!String(displayName || "").trim()) errors.push("Display name is required.");
  if (!isValidRole(role)) errors.push("Pick a role.");
  if (password !== undefined && String(password).length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // One person, one account. Two logins pointing at the same directory
  // person would each be shown the other's tickets as their own, so the
  // clash is refused here rather than discovered at sync time.
  if (directoryUserId) {
    if (!directoryPerson(directoryUserId)) {
      errors.push("That person is not in the directory any more — pick somebody else.");
    }
    const owner = store.users.find((u) => u.id !== existingId && u.directoryUserId === directoryUserId);
    if (owner) errors.push(`That person already signs in as @${owner.username}.`);
  }
  return errors;
}

// Guards the one state nobody can recover from through the UI: no super
// admin left to hand the role back out.
function isLastActiveSuperAdmin(store, userId) {
  const others = store.users.filter(
    (u) => u.id !== userId && u.role === "superadmin" && u.active !== false
  );
  return others.length === 0;
}

// ---------- seed ----------

/**
 * Creates the first super admin the first time the server runs — from
 * ADMIN_USERNAME / ADMIN_PASSWORD when they are set, and the documented
 * default above otherwise. Returns what it used so index.js can print it.
 * Afterwards only the hash is stored, so the password cannot be read back
 * out of auth.json by anyone, which is why that printout matters.
 */
function seedIfEmpty() {
  const store = load();
  if (store.users.length) return null;

  const username = normalizeUsername(process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const { salt, hash } = newCredentials(password);

  store.users.push({
    id: crypto.randomUUID(),
    username,
    displayName: "Super Admin",
    role: "superadmin",
    directoryUserId: null,
    salt, hash,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: null
  });
  save(store);
  return { username, password, isDefault: !process.env.ADMIN_PASSWORD };
}

// True while the super admin is still on the published default. The server
// re-checks this on every start, so the warning keeps appearing rather than
// being shown once on the run nobody was watching.
function usingDefaultPassword() {
  const user = load().users.find((u) => u.username === DEFAULT_ADMIN_USERNAME);
  return !!user && passwordMatches(user, DEFAULT_ADMIN_PASSWORD);
}

// ---------- sessions ----------

function pruneSessions(store) {
  const now = Date.now();
  Object.keys(store.sessions).forEach((token) => {
    const session = store.sessions[token];
    if (!session || new Date(session.expiresAt).getTime() <= now) delete store.sessions[token];
  });
}

function signIn(username, password) {
  const name = normalizeUsername(username);
  const lock = failures.get(name);
  if (lock && lock.until > Date.now()) {
    const minutes = Math.ceil((lock.until - Date.now()) / 60000);
    return { ok: false, error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const store = load();
  const user = store.users.find((u) => u.username === name);

  // One message covers both "no such user" and "wrong password" — separate
  // ones would tell an attacker which usernames exist.
  if (!user || !passwordMatches(user, password)) {
    const count = (lock && lock.until > Date.now() ? lock.count : 0) + 1;
    failures.set(name, { count, until: count >= LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_MS : 0 });
    return { ok: false, error: "That username and password don't match." };
  }
  if (user.active === false) {
    return { ok: false, error: "That account has been deactivated. Ask a super admin to re-enable it." };
  }

  failures.delete(name);
  pruneSessions(store);

  const token = crypto.randomBytes(32).toString("hex");
  store.sessions[token] = {
    userId: user.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  user.lastLoginAt = new Date().toISOString();
  save(store);

  return { ok: true, token, user: publicUser(user), maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

function signOut(token) {
  if (!token) return;
  const store = load();
  if (store.sessions[token]) {
    delete store.sessions[token];
    save(store);
  }
}

// Resolves a session cookie to the user behind it. A deactivated account
// stops resolving immediately, so revoking access doesn't wait out the
// session's expiry.
function userForToken(token) {
  if (!token) return null;
  const store = load();
  const session = store.sessions[token];
  if (!session) return null;

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    delete store.sessions[token];
    save(store);
    return null;
  }
  const user = store.users.find((u) => u.id === session.userId);
  if (!user || user.active === false) return null;
  return publicUser(user);
}

// Every session belonging to one user, dropped at once — used when their
// password changes, their role changes, or they are deactivated, so an
// already-open tab cannot keep using access they just lost.
function revokeSessionsFor(store, userId) {
  Object.keys(store.sessions).forEach((token) => {
    if (store.sessions[token].userId === userId) delete store.sessions[token];
  });
}

// ---------- user management (super admin) ----------

function listUsers() {
  return load().users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
}

function createUser({ username, displayName, role, password, directoryUserId }) {
  const store = load();
  const link = normalizeLink(directoryUserId);
  const errors = validateCredentials(store, { username, displayName, role, password, directoryUserId: link });
  if (errors.length) return { ok: false, errors };

  const { salt, hash } = newCredentials(password);
  const user = {
    id: crypto.randomUUID(),
    username: normalizeUsername(username),
    displayName: String(displayName).trim(),
    role,
    directoryUserId: link,
    salt, hash,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: null
  };
  store.users.push(user);
  save(store);
  return { ok: true, user: publicUser(user) };
}

function updateUser(userId, { username, displayName, role, active, directoryUserId }, actingUserId) {
  const store = load();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return { ok: false, errors: ["That user no longer exists."] };

  const nextRole = role || user.role;
  const nextActive = active === undefined ? user.active !== false : !!active;
  const nextLink = directoryUserId === undefined
    ? normalizeLink(user.directoryUserId)
    : normalizeLink(directoryUserId);

  const errors = validateCredentials(store,
    { username, displayName, role: nextRole, directoryUserId: nextLink }, userId);
  if (errors.length) return { ok: false, errors };

  const losingSuperAdmin = user.role === "superadmin" && (nextRole !== "superadmin" || !nextActive);
  if (losingSuperAdmin && isLastActiveSuperAdmin(store, userId)) {
    return { ok: false, errors: ["This is the only active super admin — promote someone else first."] };
  }
  if (userId === actingUserId && !nextActive) {
    return { ok: false, errors: ["You can't deactivate your own account."] };
  }

  // A role change or a deactivation has to take effect now, not whenever
  // their open tab happens to reload.
  const privilegeChanged = nextRole !== user.role || nextActive !== (user.active !== false);

  user.username = normalizeUsername(username);
  user.displayName = String(displayName).trim();
  user.role = nextRole;
  user.directoryUserId = nextLink;
  user.active = nextActive;
  user.updatedAt = new Date().toISOString();

  if (privilegeChanged) revokeSessionsFor(store, userId);
  save(store);
  return { ok: true, user: publicUser(user) };
}

function deleteUser(userId, actingUserId) {
  const store = load();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return { ok: false, errors: ["That user no longer exists."] };
  if (userId === actingUserId) return { ok: false, errors: ["You can't remove your own account."] };
  if (user.role === "superadmin" && isLastActiveSuperAdmin(store, userId)) {
    return { ok: false, errors: ["This is the only active super admin — promote someone else first."] };
  }

  store.users = store.users.filter((u) => u.id !== userId);
  revokeSessionsFor(store, userId);
  save(store);
  return { ok: true };
}

// A super admin setting someone else's password. No current password is
// asked for — that is what makes it a reset.
function setPassword(userId, password) {
  const store = load();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return { ok: false, errors: ["That user no longer exists."] };
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    return { ok: false, errors: [`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`] };
  }

  const { salt, hash } = newCredentials(password);
  user.salt = salt;
  user.hash = hash;
  user.updatedAt = new Date().toISOString();
  revokeSessionsFor(store, userId);
  save(store);
  return { ok: true };
}

// Anyone changing their own password, which does need the current one.
// Their sessions are dropped; the caller re-issues the one in hand.
function changeOwnPassword(userId, currentPassword, newPassword) {
  const store = load();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return { ok: false, errors: ["That user no longer exists."] };
  if (!passwordMatches(user, currentPassword)) {
    return { ok: false, errors: ["Your current password isn't right."] };
  }
  if (String(newPassword || "").length < MIN_PASSWORD_LENGTH) {
    return { ok: false, errors: [`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`] };
  }

  const { salt, hash } = newCredentials(newPassword);
  user.salt = salt;
  user.hash = hash;
  user.updatedAt = new Date().toISOString();
  revokeSessionsFor(store, userId);
  save(store);
  return { ok: true };
}

/**
 * Bridges accounts written before the link existed, when each one carried
 * its own copy of the Jira names.
 *
 * The match uses exactly the rule the ticket sync uses — data.js
 * matchUserIdsByLabels — so a converted account and a ticket cannot end up
 * disagreeing about who a label belongs to. Names resolving to two
 * different people, or to nobody, are left unlinked for a super admin to
 * settle by hand rather than guessed at.
 *
 * Runs on every boot; a no-op once there is nothing left to convert.
 * Returns what it did so index.js can say so on the console.
 */
function linkAccountsToDirectory() {
  const store = load();
  const people = readDirectory();
  const linked = [];
  const unresolved = [];
  let changed = false;

  store.users.forEach((user) => {
    if (!("jiraNames" in user)) return;
    const names = Array.isArray(user.jiraNames) ? user.jiraNames : [];

    // Already linked, or nothing to go on: the old field has been
    // superseded and can go.
    if (user.directoryUserId || !names.length) {
      delete user.jiraNames;
      changed = true;
      return;
    }

    const { matched } = matchUserIdsByLabels(names, people);
    if (matched.length !== 1) {
      // Nobody, or more than one person, answers to these. Keep the names
      // exactly as they were — deleting them would destroy the only record
      // of what this account used to answer to, which is the very thing
      // somebody needs in order to fix it. publicUser() ignores the field,
      // so it grants nothing; it just stays readable, and stays reported
      // on every boot until a super admin settles it.
      unresolved.push(`@${user.username} (${names.join(", ")})`);
      return;
    }

    user.directoryUserId = matched[0];
    delete user.jiraNames;
    changed = true;
    const person = people.find((p) => p.id === matched[0]);
    linked.push(`@${user.username} → ${person ? person.name : matched[0]}`);
  });

  if (changed) save(store);
  return { linked, unresolved };
}

module.exports = {
  AUTH_ROLES, roleCan,
  MIN_PASSWORD_LENGTH, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD,
  useDirectory, linkAccountsToDirectory,
  seedIfEmpty, usingDefaultPassword, signIn, signOut, userForToken,
  listUsers, createUser, updateUser, deleteUser, setPassword, changeOwnPassword
};

// ---------- command line ----------
// Run this file directly to fix credentials from outside the app. The case
// it exists for is a forgotten password, where the app itself is no help
// because signing in is exactly what you cannot do.
//
//   node auth-store.js list
//   node auth-store.js set-password <username> <password>
//   node auth-store.js reset          — admin back to the default password
//
// Changes land immediately: auth.json is read fresh on every request, so a
// running server picks them up without a restart.
if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const findByName = (name) => load().users.find((u) => u.username === normalizeUsername(name));

  if (command === "list") {
    const users = load().users;
    if (!users.length) console.log("No accounts yet — start the server once and it seeds one.");
    users.forEach((u) => console.log(`${u.username}\t${u.role}\t${u.active === false ? "deactivated" : "active"}`));

  } else if (command === "set-password") {
    const [name, password] = rest;
    const user = findByName(name);
    if (!user) {
      console.error(`No account called "${name}". Try: node auth-store.js list`);
      process.exit(1);
    }
    const result = setPassword(user.id, password || "");
    if (!result.ok) { console.error(result.errors.join(" ")); process.exit(1); }
    console.log(`Password set for ${user.username}. Any session it had is now signed out.`);

  } else if (command === "reset") {
    const user = findByName(DEFAULT_ADMIN_USERNAME);
    if (!user) {
      console.error(`There is no "${DEFAULT_ADMIN_USERNAME}" account to reset. Try: node auth-store.js list`);
      process.exit(1);
    }
    setPassword(user.id, DEFAULT_ADMIN_PASSWORD);
    console.log(`${DEFAULT_ADMIN_USERNAME} is back to the default password: ${DEFAULT_ADMIN_PASSWORD}`);
    console.log("Change it once you are in.");

  } else {
    console.log("usage: node auth-store.js list");
    console.log("       node auth-store.js set-password <username> <password>");
    console.log("       node auth-store.js reset");
  }
}
