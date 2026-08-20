/**
 * Signing in, signing out, and changing your own password.
 *
 * Everything that decides whether someone gets a session lives here. Routes
 * above this file parse and serialise; they make no decisions.
 */

const { db, tx } = require("../db/client.js");
const authUsers = require("../repositories/auth-users.repo.js");
const directoryUsers = require("../repositories/directory-users.repo.js");
const passwords = require("../security/passwords.js");
const policy = require("./password-policy.js");
const sessionService = require("./session.service.js");
const throttle = require("./throttle.service.js");
const audit = require("./audit.service.js");
const { ValidationError, UnauthorizedError, ForbiddenError } = require("../http/errors.js");

// One message for every way a sign-in can fail. Distinguishing "no such user"
// from "wrong password" tells an attacker which usernames are worth attacking,
// and the audit log records the real reason for whoever is entitled to it.
const SIGN_IN_FAILED = "That username and password don't match an account.";

/**
 * Fills in the Jira labels belonging to the directory person this login speaks
 * for. The UI shows them on the account menu; they are not a property of the
 * login itself, which is why this reaches across rather than storing a copy.
 */
async function withJiraNames(executor, row) {
  if (!row) return null;
  let jiraNames = [];
  if (row.directory_user_id) {
    const person = await directoryUsers.findById(executor, row.directory_user_id);
    if (person) jiraNames = person.jiraNames;
  }
  return authUsers.toPublicUser(row, jiraNames);
}

/**
 * Verifies credentials and mints a session.
 *
 * The shape of this function matters as much as its result: every path that
 * fails performs exactly one password verification, so a missing account and a
 * wrong password take the same time. Without that, the deliberately identical
 * error message above is defeated with a stopwatch.
 */
async function signIn({ username, password, ip, userAgent, ctx }) {
  const name = String(username || "").trim();
  const secret = String(password || "");

  if (!name || !secret) {
    throw new ValidationError(["Enter your username and password."]);
  }

  const gate = await throttle.check(name, ip);
  if (!gate.allowed) {
    // Still burn a verification, so a throttled attempt is indistinguishable
    // in timing from one that was actually checked.
    await passwords.burn(secret);
    await throttle.recordFailure(name, ip, "throttled", userAgent);
    audit.queue(audit.EVENTS.LOGIN_THROTTLED, ctx, {
      outcome: "failure",
      target: { type: "user", label: name },
      detail: { reason: gate.reason, retryAfterMs: gate.retryAfterMs,
                distinctUsernames: gate.distinctUsernames }
    });
    if (gate.reason === "ip") {
      audit.queue(audit.EVENTS.SPRAY_DETECTED, ctx, {
        outcome: "failure",
        detail: { distinctUsernames: gate.distinctUsernames }
      });
    }
    throw new ForbiddenError(
      `Too many failed attempts. Try again in ${throttle.describeWait(gate.retryAfterMs)}.`,
      { code: "throttled" }
    );
  }

  const row = await authUsers.findByUsername(db, name);

  // The account does not exist: verify against a hash of something nobody
  // knows, so this path costs what a real one costs.
  if (!row) {
    await passwords.burn(secret);
    await throttle.recordFailure(name, ip, "no-such-user", userAgent);
    audit.queue(audit.EVENTS.LOGIN_FAILED, ctx, {
      outcome: "failure",
      target: { type: "user", label: name },
      detail: { reason: "no-such-user" }
    });
    throw new UnauthorizedError(SIGN_IN_FAILED, { code: "bad-credentials" });
  }

  const result = await passwords.verify(secret, row.password_hash);

  if (!result.ok) {
    await throttle.recordFailure(name, ip, "bad-password", userAgent);
    audit.queue(audit.EVENTS.LOGIN_FAILED, ctx, {
      outcome: "failure",
      target: { type: "user", id: row.id, label: row.username },
      detail: { reason: "bad-password" }
    });
    throw new UnauthorizedError(SIGN_IN_FAILED, { code: "bad-credentials" });
  }

  // Deactivation is checked after the password, not before: answering "that
  // account is disabled" to an unauthenticated caller confirms the username
  // exists to anyone who guesses it.
  if (!authUsers.toPublicUser(row).active) {
    await throttle.recordFailure(name, ip, "deactivated", userAgent);
    audit.queue(audit.EVENTS.LOGIN_FAILED, ctx, {
      outcome: "failure",
      target: { type: "user", id: row.id, label: row.username },
      detail: { reason: "deactivated" }
    });
    throw new UnauthorizedError(SIGN_IN_FAILED, { code: "bad-credentials" });
  }

  const session = await sessionService.create(row.id, { ip, userAgent });
  await authUsers.update(db, row.id, { lastLoginAt: new Date() });
  await throttle.recordSuccess(name, ip, userAgent);

  // The stored hash was made with parameters this build no longer uses. The
  // password is correct and in scope right now, which is the only moment it can
  // be re-hashed -- so do it, but after the caller has their answer.
  if (result.needsRehash) {
    scheduleRehash(row.id, secret);
  }

  const user = await withJiraNames(db, { ...row, last_login_at: new Date() });

  audit.queue(audit.EVENTS.LOGIN_SUCCEEDED, null, {
    actor: {
      actorUserId: row.id, actorUsername: row.username, actorRole: row.role,
      actorIp: ip, actorSessionId: session.sessionId, actorUserAgent: userAgent
    }
  });

  return { user, session };
}

/**
 * Re-hashes in the background. Deliberately fire-and-forget: the user is
 * already authenticated, and making them wait ~100ms for an upgrade they did
 * not ask for would be paying for tidiness with their time.
 */
function scheduleRehash(userId, plaintext) {
  setImmediate(async () => {
    try {
      const next = await passwords.hash(plaintext);
      await authUsers.replaceHash(db, userId, next);
      audit.queue(audit.EVENTS.PASSWORD_REHASHED, null, {
        actor: { actorUserId: userId },
        target: { type: "user", id: userId },
        detail: { paramsTo: `n=${passwords.CURRENT_PARAMS.n}` }
      });
    } catch (err) {
      // The old hash still verifies, so this is not worth failing anything over.
      console.error(`[auth] could not re-hash password for ${userId}: ${err.message}`);
    }
  });
}

async function signOut(token, ctx) {
  if (!token) return;
  await sessionService.revokeToken(token, "logout");
  if (ctx && ctx.user) {
    audit.queue(audit.EVENTS.LOGOUT, ctx);
  }
}

/**
 * Changes your own password.
 *
 * Revokes every other session, then issues a fresh one for the tab that made
 * the change -- so changing your password signs out your other devices without
 * signing out the device you are typing on.
 */
async function changeOwnPassword(ctx, { currentPassword, newPassword }) {
  const row = await authUsers.findById(db, ctx.user.id);
  if (!row) throw new UnauthorizedError();

  const current = await passwords.verify(String(currentPassword || ""), row.password_hash);
  if (!current.ok) {
    audit.queue(audit.EVENTS.LOGIN_FAILED, ctx, {
      outcome: "failure",
      target: { type: "user", id: row.id, label: row.username },
      detail: { reason: "bad-password", route: "change-password" }
    });
    throw new ValidationError(["Your current password is not correct."]);
  }

  const errors = policy.check(newPassword, {
    username: row.username,
    displayName: row.display_name
  });
  if (errors.length) throw new ValidationError(errors);

  if (String(newPassword) === String(currentPassword)) {
    throw new ValidationError(["Your new password must be different from your current one."]);
  }

  const hash = await passwords.hash(newPassword);

  await tx(async (t) => {
    await authUsers.setPassword(t, row.id, hash, { mustChangePassword: false });
    await audit.record(t, audit.EVENTS.PASSWORD_CHANGED, ctx, {
      target: { type: "user", id: row.id, label: row.username }
    });
  });

  await sessionService.revokeAllForUser(row.id, "password-change");

  const session = await sessionService.create(row.id, {
    ip: ctx.clientIp,
    userAgent: ctx.userAgent
  });

  const user = await withJiraNames(db, { ...row, must_change_password: 0 });
  return { user, session };
}

/** The account behind the current request, refreshed from the database. */
async function currentUser(ctx) {
  if (!ctx.user) return null;
  const row = await authUsers.findById(db, ctx.user.id);
  return withJiraNames(db, row);
}

module.exports = { signIn, signOut, changeOwnPassword, currentUser, withJiraNames };
