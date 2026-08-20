/**
 * Directory people: the names a claim can be attributed to.
 *
 * Deliberately separate from auth_users -- see the design note at the top of
 * server/db/migrations/002_auth.sql. This table is broadcast to every
 * signed-in browser; auth_users never is.
 */

const crypto = require("node:crypto");
const { db, tx } = require("../db/client.js");
const directoryRepo = require("../repositories/directory-users.repo.js");
const claimsRepo = require("../repositories/claims.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const audit = require("./audit.service.js");
const rules = require("../../shared/rules.js");
const { ValidationError, NotFoundError } = require("../http/errors.js");

function uid() {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function boardSnapshot(executor) {
  return { users: await directoryRepo.list(executor) };
}

async function create(ctx, { id: requestedId, name, role, jiraNames }) {
  const person = await tx(async (t) => {
    const board = await boardSnapshot(t);
    const errors = rules.validateDirectoryUser(board, null, { name, role, jiraNames });
    if (errors.length) throw new ValidationError(errors);

    const nextName = String(name).trim();
    const nextJiraNames = rules.normalizeJiraNames(jiraNames, nextName);
    // Prefer the id the caller already minted -- see the matching comment in
    // servers.service.js's create(). Without this, the directory-user.upserted
    // event this call emits arrives under a different id than the browser's
    // own optimistic copy and reads as a second person, not an update.
    const id = requestedId && !(await directoryRepo.findById(t, requestedId)) ? String(requestedId) : uid();
    const position = await directoryRepo.nextPosition(t);

    await directoryRepo.insert(t, { id, name: nextName, jobTitle: String(role).trim(), position });
    await directoryRepo.setJiraNames(t, id, nextJiraNames);

    await audit.record(t, audit.EVENTS.DIRECTORY_CREATED, ctx, {
      target: { type: "directory-user", id, label: nextName },
      detail: { jobTitle: role, jiraNames: nextJiraNames }
    });

    return directoryRepo.findById(t, id);
  });

  await bus.emit(EVENTS.DIRECTORY_USER_UPSERTED, person, { origin: ctx.clientId });
  return person;
}

/**
 * A person's Jira names are what "Ticket Assignee" labels are matched against
 * (shared/data.js matchUserIdsByLabels), so editing them changes who the next
 * sync resolves a ticket to. Claims reference people by id, so the ones
 * already on the board follow a rename on their own -- nothing here touches
 * claim_users.
 */
async function update(ctx, userId, { name, role, jiraNames }) {
  const person = await tx(async (t) => {
    const existing = await directoryRepo.findById(t, userId);
    if (!existing) throw new NotFoundError("User not found.");

    const board = await boardSnapshot(t);
    const errors = rules.validateDirectoryUser(board, userId, {
      name,
      role,
      jiraNames: jiraNames === undefined ? existing.jiraNames : jiraNames
    });
    if (errors.length) throw new ValidationError(errors);

    const nextName = String(name).trim();
    const nextJiraNames = rules.normalizeJiraNames(
      jiraNames === undefined ? existing.jiraNames : jiraNames, nextName
    );

    await directoryRepo.update(t, userId, { name: nextName, jobTitle: String(role).trim() });
    await directoryRepo.setJiraNames(t, userId, nextJiraNames);

    await audit.record(t, audit.EVENTS.DIRECTORY_UPDATED, ctx, {
      target: { type: "directory-user", id: userId, label: nextName },
      detail: { fields: ["name", "role", "jiraNames"] }
    });

    return directoryRepo.findById(t, userId);
  });

  await bus.emit(EVENTS.DIRECTORY_USER_UPSERTED, person, { origin: ctx.clientId });
  return person;
}

/**
 * Deliberately leaves claim_users pointing at the removed id -- the UI renders
 * the raw id as a fallback label for a claim's past attribution, matching the
 * existing behaviour exactly. There is no foreign key to clean up because
 * claim_users.user_id is not one, on purpose.
 */
async function remove(ctx, userId) {
  const existing = await directoryRepo.findById(db, userId);
  if (!existing) throw new NotFoundError("User not found.");

  await tx(async (t) => {
    await audit.record(t, audit.EVENTS.DIRECTORY_DELETED, ctx, {
      target: { type: "directory-user", id: userId, label: existing.name }
    });
    await directoryRepo.remove(t, userId);
  });

  await bus.emit(EVENTS.DIRECTORY_USER_DELETED, { id: userId }, { origin: ctx.clientId });
  return { ok: true };
}

module.exports = { create, update, remove };
