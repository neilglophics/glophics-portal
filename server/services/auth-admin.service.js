/**
 * Managing other people's logins.
 *
 * Every rule the previous implementation enforced is preserved here, including
 * the two that exist to stop somebody locking everybody out:
 *   - the last active super admin cannot be demoted, deactivated or removed;
 *   - you cannot deactivate or delete the account you are signed in as.
 *
 * A privilege change revokes the affected sessions inside the same transaction
 * as the change itself. That is the difference between "your role changed" and
 * "your role changed and your open tab found out".
 */

const crypto = require("node:crypto");
const { db, tx } = require("../db/client.js");
const authUsers = require("../repositories/auth-users.repo.js");
const directoryUsers = require("../repositories/directory-users.repo.js");
const sessionsRepo = require("../repositories/auth-sessions.repo.js");
const passwords = require("../security/passwords.js");
const policy = require("./password-policy.js");
const sessionService = require("./session.service.js");
const audit = require("./audit.service.js");
const { withJiraNames } = require("./auth.service.js");
const { ValidationError, NotFoundError } = require("../http/errors.js");
const { isValidRole } = require("../../shared/data.js");

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

/** Blank, whitespace, or the form's "Nobody" option all mean unlinked. */
function normalizeLink(value) {
  const id = String(value == null ? "" : value).trim();
  return id || null;
}

async function validate(executor, { username, displayName, role, password, directoryUserId }, existingId = null) {
  const errors = [];
  const name = normalizeUsername(username);

  if (!name) {
    errors.push("Username is required.");
  } else if (!USERNAME_PATTERN.test(name)) {
    errors.push("Username must be 3-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.");
  } else {
    const taken = await authUsers.findByUsername(executor, name);
    if (taken && taken.id !== existingId) {
      errors.push(`The username "${name}" is already taken.`);
    }
  }

  if (!String(displayName || "").trim()) errors.push("Display name is required.");
  if (!isValidRole(role)) errors.push("Pick a role.");

  if (password !== undefined) {
    errors.push(...policy.check(password, { username: name, displayName }));
  }

  // One person, one login. Two logins pointing at the same directory person
  // would each be shown the other's tickets as their own, so the clash is
  // refused here rather than discovered at sync time.
  if (directoryUserId) {
    const person = await directoryUsers.findById(executor, directoryUserId);
    if (!person) {
      errors.push("That person is not in the directory any more — pick somebody else.");
    }
    const owner = await authUsers.findByDirectoryUserId(executor, directoryUserId);
    if (owner && owner.id !== existingId) {
      errors.push(`That person already signs in as @${owner.username}.`);
    }
  }

  return errors;
}

/** True when removing this account's super-admin status would leave none. */
async function isLastActiveSuperAdmin(executor, userId) {
  const others = await authUsers.countActiveWithRole(executor, "superadmin", userId);
  return others === 0;
}

async function list() {
  const rows = await authUsers.list(db);
  const linked = rows.map((row) => row.directory_user_id).filter(Boolean);
  const labels = await directoryUsers.labelsByUser(db, linked);
  return rows.map((row) =>
    authUsers.toPublicUser(row, labels.get(row.directory_user_id) || [])
  );
}

async function create(ctx, input) {
  const link = normalizeLink(input.directoryUserId);
  const errors = await validate(db, { ...input, directoryUserId: link });
  if (errors.length) throw new ValidationError(errors);

  const hash = await passwords.hash(input.password);
  const user = {
    id: crypto.randomUUID(),
    username: normalizeUsername(input.username),
    displayName: String(input.displayName).trim(),
    role: input.role,
    directoryUserId: link,
    passwordHash: hash,
    passwordChangedAt: new Date(),
    // The admin who typed this password knows it, so its owner must replace it.
    mustChangePassword: true,
    active: true
  };

  await tx(async (t) => {
    await authUsers.insert(t, user);
    await audit.record(t, audit.EVENTS.USER_CREATED, ctx, {
      target: { type: "user", id: user.id, label: user.username },
      detail: { role: user.role, displayName: user.displayName }
    });
  });

  const row = await authUsers.findById(db, user.id);
  return withJiraNames(db, row);
}

async function update(ctx, userId, patch) {
  const row = await authUsers.findById(db, userId);
  if (!row) throw new NotFoundError("That user no longer exists.");

  const current = authUsers.toPublicUser(row);
  const nextRole = patch.role || current.role;
  const nextActive = patch.active === undefined ? current.active : Boolean(patch.active);
  const nextLink = patch.directoryUserId === undefined
    ? current.directoryUserId
    : normalizeLink(patch.directoryUserId);

  const errors = await validate(
    db,
    {
      username: patch.username,
      displayName: patch.displayName,
      role: nextRole,
      directoryUserId: nextLink
    },
    userId
  );
  if (errors.length) throw new ValidationError(errors);

  const losingSuperAdmin =
    current.role === "superadmin" && (nextRole !== "superadmin" || !nextActive);
  if (losingSuperAdmin && (await isLastActiveSuperAdmin(db, userId))) {
    throw new ValidationError([
      "This is the only active super admin — promote someone else first."
    ]);
  }
  if (userId === ctx.user.id && !nextActive) {
    throw new ValidationError(["You can't deactivate your own account."]);
  }

  // A role change or a deactivation has to take effect now, not whenever their
  // open tab happens to reload.
  const privilegeChanged = nextRole !== current.role || nextActive !== current.active;

  let revoked = [];
  await tx(async (t) => {
    await authUsers.update(t, userId, {
      username: normalizeUsername(patch.username),
      displayName: String(patch.displayName).trim(),
      role: nextRole,
      directoryUserId: nextLink,
      active: nextActive
    });

    if (privilegeChanged) {
      revoked = await sessionsRepo.revokeAllForUser(t, userId, "privilege-change");
    }

    if (nextRole !== current.role) {
      await audit.record(t, audit.EVENTS.USER_ROLE_CHANGED, ctx, {
        target: { type: "user", id: userId, label: current.username },
        detail: { previousRole: current.role, role: nextRole }
      });
    }
    if (nextActive !== current.active) {
      await audit.record(
        t,
        nextActive ? audit.EVENTS.USER_ACTIVATED : audit.EVENTS.USER_DEACTIVATED,
        ctx,
        { target: { type: "user", id: userId, label: current.username } }
      );
    }
    await audit.record(t, audit.EVENTS.USER_UPDATED, ctx, {
      target: { type: "user", id: userId, label: current.username },
      detail: {
        fields: Object.keys(patch),
        previousUsername: current.username !== normalizeUsername(patch.username)
          ? current.username : undefined
      }
    });
  });

  // The transaction has committed, so the in-process cache is the only place
  // left that could still honour a revoked session. Clear it now.
  if (privilegeChanged) {
    await sessionService.revokeAllForUser(userId, "privilege-change");
  }

  return withJiraNames(db, await authUsers.findById(db, userId));
}

async function remove(ctx, userId) {
  const row = await authUsers.findById(db, userId);
  if (!row) throw new NotFoundError("That user no longer exists.");

  const current = authUsers.toPublicUser(row);
  if (userId === ctx.user.id) {
    throw new ValidationError(["You can't remove your own account."]);
  }
  if (current.role === "superadmin" && (await isLastActiveSuperAdmin(db, userId))) {
    throw new ValidationError([
      "This is the only active super admin — promote someone else first."
    ]);
  }

  await tx(async (t) => {
    // Audit first: the foreign key nulls actor references on delete, and the
    // denormalised username on the entry is what keeps the record readable.
    await audit.record(t, audit.EVENTS.USER_DELETED, ctx, {
      target: { type: "user", id: userId, label: current.username },
      detail: { role: current.role }
    });
    await sessionsRepo.revokeAllForUser(t, userId, "account-deleted");
    await authUsers.remove(t, userId);
  });

  await sessionService.revokeAllForUser(userId, "account-deleted");
  return { ok: true };
}

/**
 * A super admin setting somebody else's password. No current password is asked
 * for -- that is what makes it a reset rather than a change.
 */
async function resetPassword(ctx, userId, password) {
  const row = await authUsers.findById(db, userId);
  if (!row) throw new NotFoundError("That user no longer exists.");

  const current = authUsers.toPublicUser(row);
  const errors = policy.check(password, {
    username: current.username,
    displayName: current.displayName
  });
  if (errors.length) throw new ValidationError(errors);

  const hash = await passwords.hash(password);

  await tx(async (t) => {
    // Whoever typed this password is not its owner, so its owner replaces it.
    await authUsers.setPassword(t, userId, hash, { mustChangePassword: true });
    await sessionsRepo.revokeAllForUser(t, userId, "admin-reset");
    await audit.record(t, audit.EVENTS.PASSWORD_RESET, ctx, {
      target: { type: "user", id: userId, label: current.username }
    });
  });

  await sessionService.revokeAllForUser(userId, "admin-reset");
  return { ok: true };
}

module.exports = {
  list, create, update, remove, resetPassword,
  normalizeUsername, normalizeLink, USERNAME_PATTERN
};
