/**
 * Environments: creating them, editing them, and the ripple an edit causes
 * across the claims and notes that belong to them.
 *
 * An edit here can rename the environment and move it to a different account in
 * the same request. Both of those change what "the same repo" means to every
 * claim and note already attached, so the ripple is not an edge case -- it is
 * the normal shape of this write, and it all happens in one transaction.
 */

const { db, tx } = require("../db/client.js");
const serversRepo = require("../repositories/servers.repo.js");
const accountsRepo = require("../repositories/accounts.repo.js");
const claimsRepo = require("../repositories/claims.repo.js");
const notesRepo = require("../repositories/notes.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const audit = require("./audit.service.js");
const rules = require("../../shared/rules.js");
const { ValidationError, NotFoundError } = require("../http/errors.js");

function uid() {
  return `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function boardSnapshot(executor) {
  return {
    servers: await serversRepo.list(executor),
    accounts: await accountsRepo.list(executor)
  };
}

async function create(ctx, { id: requestedId, name, accountId, repoUrls }) {
  const server = await tx(async (t) => {
    const board = await boardSnapshot(t);
    const errors = rules.validateServer(board, null, { name, accountId });
    if (errors.length) throw new ValidationError(errors);

    const account = board.accounts.find((a) => a.id === accountId);
    // Prefer the id the caller already minted -- state.js's addServer applies
    // one to its optimistic local copy before this request is even sent, and
    // using the same one here is what lets the resulting server.upserted
    // event update that copy in place instead of appearing as a duplicate.
    const id = requestedId && !(await serversRepo.exists(t, requestedId)) ? String(requestedId) : uid();
    const position = await serversRepo.nextPosition(t);
    await serversRepo.insert(t, { id, name: String(name).trim(), accountId: account.id, position });

    let repoPosition = 0;
    for (const repoName of account.repositories) {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      await serversRepo.upsertRepo(t, id, repoName, { url, position: repoPosition });
      repoPosition += 1;
    }

    await audit.record(t, audit.EVENTS.SERVER_CHANGED, ctx, {
      target: { type: "server", id, label: name },
      detail: { accountId: account.id, reason: "created" }
    });

    return serversRepo.findById(t, id);
  });

  await bus.emit(EVENTS.SERVER_UPSERTED, server, { origin: ctx.clientId });
  return server;
}

/**
 * Renaming an environment or moving it to a different account changes what its
 * repos are (an account defines the repo slots) and what its claims should say
 * for account name and branch -- both denormalised onto the claim for display.
 * All of that happens here, in the same transaction as the edit itself.
 */
async function update(ctx, serverId, { name, accountId, repoUrls }) {
  const result = await tx(async (t) => {
    const existing = await serversRepo.findById(t, serverId);
    if (!existing) throw new NotFoundError("Environment not found.");

    const board = await boardSnapshot(t);
    const nextAccountId = accountId || existing.accountId;
    const errors = rules.validateServer(board, serverId, { name, accountId: nextAccountId });
    if (errors.length) throw new ValidationError(errors);

    const account = board.accounts.find((a) => a.id === nextAccountId);
    const nextName = String(name).trim();

    await serversRepo.update(t, serverId, { name: nextName, accountId: account.id });

    const currentRepoNames = Object.keys(existing.repos);
    const nextRepoNames = account.repositories;
    const removedRepos = currentRepoNames.filter((r) => !nextRepoNames.includes(r));

    let position = 0;
    for (const repoName of nextRepoNames) {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      const current = existing.repos[repoName];
      // An untouched url keeps the health last measured for it; only a
      // changed one goes back to "checking" for the health job to re-verify.
      if (current && current.url === url) {
        position += 1;
        continue;
      }
      await serversRepo.upsertRepo(t, serverId, repoName, { url, position });
      if (url) {
        await t.run("update server_repos set health = 'checking' where server_id = ? and repo_name = ?", [serverId, repoName]);
      }
      position += 1;
    }
    for (const repoName of removedRepos) {
      await serversRepo.removeRepo(t, serverId, repoName);
    }

    const renamedClaims = await claimsRepo.renameAccount(t, [serverId], account.displayName);
    // Branch (the environment's own name) is rewritten unconditionally since a
    // claim's branch always mirrors its environment's current name.
    if (nextName !== existing.name) {
      await t.run("update claims set branch = ? where server_id = ?", [nextName, serverId]);
    }

    let emptiedClaimIds = [];
    if (removedRepos.length) {
      const dropped = await claimsRepo.dropRepos(t, [serverId], removedRepos);
      if (dropped.emptied.length) {
        await claimsRepo.removeMany(t, dropped.emptied);
        emptiedClaimIds = dropped.emptied;
      }
    }

    await audit.record(t, audit.EVENTS.SERVER_CHANGED, ctx, {
      target: { type: "server", id: serverId, label: nextName },
      detail: { accountId: account.id, fields: ["name", "accountId", "repoUrls"] }
    });

    return {
      server: await serversRepo.findById(t, serverId),
      affectedClaimIds: [...new Set([...renamedClaims, ...emptiedClaimIds])],
      emptiedClaimIds
    };
  });

  await bus.emit(EVENTS.SERVER_UPSERTED, result.server, { origin: ctx.clientId });
  for (const id of result.emptiedClaimIds) {
    await bus.emit(EVENTS.CLAIM_DELETED, { id }, { origin: ctx.clientId });
  }
  const stillLiveIds = result.affectedClaimIds.filter((id) => !result.emptiedClaimIds.includes(id));
  for (const id of stillLiveIds) {
    const claim = await claimsRepo.findById(db, id);
    if (claim) await bus.emit(EVENTS.CLAIM_UPDATED, claim, { origin: ctx.clientId });
  }

  return result.server;
}

async function remove(ctx, serverId) {
  const existing = await serversRepo.findById(db, serverId);
  if (!existing) throw new NotFoundError("Environment not found.");

  await tx(async (t) => {
    await audit.record(t, audit.EVENTS.SERVER_CHANGED, ctx, {
      target: { type: "server", id: serverId, label: existing.name },
      detail: { reason: "deleted" }
    });
    await serversRepo.remove(t, serverId);
  });

  await bus.emit(EVENTS.SERVER_DELETED, { id: serverId }, { origin: ctx.clientId });
  return { ok: true };
}

async function setRepoUrl(ctx, serverId, repoName, url) {
  const changed = await serversRepo.setRepoUrl(db, serverId, repoName, url);
  if (!changed) throw new NotFoundError("That repository was not found on this environment.");

  await db.run(
    "update server_repos set health = 'checking' where server_id = ? and repo_name = ? and trim(url) <> ''",
    [serverId, repoName]
  );

  const server = await serversRepo.findById(db, serverId);
  await bus.emit(EVENTS.SERVER_UPSERTED, server, { origin: ctx.clientId });
  return server.repos[repoName];
}

module.exports = { create, update, remove, setRepoUrl };
