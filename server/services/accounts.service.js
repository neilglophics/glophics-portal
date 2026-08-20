/**
 * Accounts: the repositories a client owns, and the environments built on
 * them.
 *
 * An account's id can change here -- renaming "singaprinting" changes the
 * primary key everything else points at. Every foreign key that references it
 * is declared ON UPDATE CASCADE, so the id change itself is one statement; what
 * this file still has to do by hand is the part no foreign key can do: rewrite
 * the account name denormalised onto every claim, and ripple a dropped
 * repository through the environments and claims built on it.
 */

const { db, tx } = require("../db/client.js");
const accountsRepo = require("../repositories/accounts.repo.js");
const serversRepo = require("../repositories/servers.repo.js");
const claimsRepo = require("../repositories/claims.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const audit = require("./audit.service.js");
const rules = require("../../shared/rules.js");
const { ValidationError, NotFoundError } = require("../http/errors.js");

async function boardSnapshot(executor) {
  return { accounts: await accountsRepo.list(executor) };
}

async function create(ctx, { id, displayName, repositories }) {
  const account = await tx(async (t) => {
    const board = await boardSnapshot(t);
    // Resolved before validation, and validation is told the resolved id --
    // not the raw `id` field -- so it checks exactly what will be applied
    // rather than re-deriving its own guess from the raw inputs.
    const nextId = String(id || "").trim() || rules.slugAccountId(displayName);
    const errors = rules.validateAccount(board, null, { id: nextId, displayName, repositories });
    if (errors.length) throw new ValidationError(errors);

    const nextRepos = [...new Set((repositories || []).map((r) => String(r).trim()).filter(Boolean))];
    const position = await accountsRepo.nextPosition(t);

    await accountsRepo.insert(t, { id: nextId, displayName: String(displayName).trim(), position });
    await accountsRepo.setRepositories(t, nextId, nextRepos);

    await audit.record(t, audit.EVENTS.ACCOUNT_CHANGED, ctx, {
      target: { type: "account", id: nextId, label: displayName },
      detail: { reason: "created", repos: nextRepos }
    });

    return accountsRepo.findById(t, nextId);
  });

  await bus.emit(EVENTS.ACCOUNT_UPSERTED, account, { origin: ctx.clientId });
  return account;
}

/**
 * Renaming the account's id ripples into `servers.account_id` and
 * `account_repositories.account_id` for free (ON UPDATE CASCADE). What is not
 * free: `claims.account_name` is a denormalised copy for display, and dropping
 * a repository has to take its environments' urls, its notes, and any claim
 * that held only that repository along with it.
 */
async function update(ctx, accountId, { id, displayName, repositories }) {
  const result = await tx(async (t) => {
    const existing = await accountsRepo.findById(t, accountId);
    if (!existing) throw new NotFoundError("Account not found.");

    const board = await boardSnapshot(t);
    const nextId = String(id || "").trim() || rules.slugAccountId(displayName);
    const errors = rules.validateAccount(board, accountId, { id: nextId, displayName, repositories });
    if (errors.length) throw new ValidationError(errors);

    const nextName = String(displayName).trim();
    const nextRepos = [...new Set((repositories || []).map((r) => String(r).trim()).filter(Boolean))];
    const removedRepos = existing.repositories.filter((r) => !nextRepos.includes(r));

    await accountsRepo.update(t, accountId, {
      newId: nextId !== accountId ? nextId : null,
      displayName: nextName
    });
    await accountsRepo.setRepositories(t, nextId, nextRepos);

    const serverIds = await serversRepo.listIdsForAccount(t, nextId);

    for (const repoName of removedRepos) {
      for (const serverId of serverIds) {
        await serversRepo.removeRepo(t, serverId, repoName);
      }
    }

    let emptiedClaimIds = [];
    if (removedRepos.length && serverIds.length) {
      const dropped = await claimsRepo.dropRepos(t, serverIds, removedRepos);
      if (dropped.emptied.length) {
        await claimsRepo.removeMany(t, dropped.emptied);
        emptiedClaimIds = dropped.emptied;
      }
    }

    const renamedClaimIds = nextName !== existing.displayName
      ? await claimsRepo.renameAccount(t, serverIds, nextName)
      : [];

    await audit.record(t, audit.EVENTS.ACCOUNT_CHANGED, ctx, {
      target: { type: "account", id: nextId, label: nextName },
      detail: { fields: ["id", "displayName", "repositories"] }
    });

    return {
      account: await accountsRepo.findById(t, nextId),
      affectedServerIds: serverIds,
      emptiedClaimIds,
      renamedClaimIds
    };
  });

  await bus.emit(EVENTS.ACCOUNT_UPSERTED, result.account, { origin: ctx.clientId });
  for (const serverId of result.affectedServerIds) {
    const server = await serversRepo.findById(db, serverId);
    if (server) await bus.emit(EVENTS.SERVER_UPSERTED, server, { origin: ctx.clientId });
  }
  for (const id of result.emptiedClaimIds) {
    await bus.emit(EVENTS.CLAIM_DELETED, { id }, { origin: ctx.clientId });
  }
  const stillLive = result.renamedClaimIds.filter((id) => !result.emptiedClaimIds.includes(id));
  for (const id of stillLive) {
    const claim = await claimsRepo.findById(db, id);
    if (claim) await bus.emit(EVENTS.CLAIM_UPDATED, claim, { origin: ctx.clientId });
  }

  return result.account;
}

/**
 * Deletion deliberately orphans its environments rather than deleting them --
 * the account_id foreign key is ON DELETE SET NULL, matching the documented
 * behaviour: "N environments belong to it and will be left without an
 * account." Their claims and notes are untouched.
 */
async function remove(ctx, accountId) {
  const existing = await accountsRepo.findById(db, accountId);
  if (!existing) throw new NotFoundError("Account not found.");

  const orphaned = await tx(async (t) => {
    const serverIds = await serversRepo.listIdsForAccount(t, accountId);
    await audit.record(t, audit.EVENTS.ACCOUNT_CHANGED, ctx, {
      target: { type: "account", id: accountId, label: existing.displayName },
      detail: { reason: "deleted", orphanedServers: serverIds }
    });
    await accountsRepo.remove(t, accountId);
    return serverIds;
  });

  await bus.emit(EVENTS.ACCOUNT_DELETED, { id: accountId, orphanedServers: orphaned }, { origin: ctx.clientId });
  for (const serverId of orphaned) {
    const server = await serversRepo.findById(db, serverId);
    if (server) await bus.emit(EVENTS.SERVER_UPSERTED, server, { origin: ctx.clientId });
  }
  return { ok: true, orphanedServers: orphaned };
}

module.exports = { create, update, remove };
