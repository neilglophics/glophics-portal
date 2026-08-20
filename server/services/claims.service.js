/**
 * Claiming and freeing environments.
 *
 * This is the write path that used to be "the browser posts the entire board".
 * Every function here changes one thing, in one transaction, and emits one
 * event describing exactly what changed -- which is what lets a claim on a
 * 500-issue board cost a few hundred bytes on the wire instead of the whole
 * board to every open tab.
 */

const { db, tx } = require("../db/client.js");
const claimsRepo = require("../repositories/claims.repo.js");
const serversRepo = require("../repositories/servers.repo.js");
const accountsRepo = require("../repositories/accounts.repo.js");
const settingsRepo = require("../repositories/settings.repo.js");
const directoryRepo = require("../repositories/directory-users.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const audit = require("./audit.service.js");
const rules = require("../../shared/rules.js");
const { ValidationError, NotFoundError, ConflictError } = require("../http/errors.js");

/** A claim id for a hold with no Jira ticket behind it. */
function manualId() {
  return `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The slice of the board the claim rules need.
 *
 * Read inside the caller's transaction so the rules judge the same state the
 * write lands on -- otherwise two people claiming the same repo at the same
 * instant would both be told yes.
 */
async function boardFor(executor, serverId) {
  const server = await serversRepo.findById(executor, serverId);
  if (!server) throw new NotFoundError("Server not found.");
  const account = server.accountId ? await accountsRepo.findById(executor, server.accountId) : null;
  const settings = await settingsRepo.get(executor);
  return { server, account, settings };
}

async function create(ctx, serverId, payload) {
  const claim = await tx(async (t) => {
    const { server, account, settings } = await boardFor(t, serverId);

    // Only repositories this environment actually carries, matching the
    // previous behaviour of filtering the request against the server's own
    // repo list rather than rejecting it.
    const available = Object.keys(server.repos);
    const repos = (payload.repos || []).filter((r) => available.includes(r));
    const jiraTicket = payload.jiraTicket ? String(payload.jiraTicket).trim().toUpperCase() : null;

    const errors = rules.validateClaim(
      { settings },
      { ...payload, repos, jiraTicket }
    );
    if (errors.length) throw new ValidationError(errors);

    // A manual claim's id is normally client-minted and sent as `id` -- the
    // browser already applied the same id to its optimistic local copy, so
    // using it here (rather than minting a second, different one) is what
    // lets the eventual `claim.created` event update that copy in place
    // instead of appearing as a second, duplicate claim next to it.
    const id = jiraTicket || (payload.id ? String(payload.id) : manualId());
    if (await claimsRepo.exists(t, id)) {
      throw new ConflictError(
        `${id} is already holding repositories. Free it before claiming again.`,
        { code: "claim-exists" }
      );
    }

    const record = {
      id,
      source: jiraTicket ? "jira" : "manual",
      serverId: server.id,
      accountName: account ? account.displayName : "",
      branch: server.name,
      repos,
      userIds: payload.userIds || [],
      rawAssignees: [],
      // "Pending sync" is what the board shows until the next Jira poll
      // replaces it with the real status.
      status: jiraTicket ? (payload.jiraStatus || "Pending sync") : "Manual",
      summary: payload.summary || null,
      note: payload.note ? String(payload.note).trim() : null,
      startTime: payload.startTime,
      endTime: payload.endTime,
      claimedAt: new Date().toISOString(),
      lastSyncedAt: null
    };

    await claimsRepo.insert(t, record);
    await audit.record(t, audit.EVENTS.CLAIM_CREATED, ctx, {
      target: { type: "claim", id, label: `${record.accountName} ${record.branch}` },
      detail: { serverId: server.id, repos, userIds: record.userIds, source: record.source }
    });

    return claimsRepo.findById(t, id);
  });

  await bus.emit(EVENTS.CLAIM_CREATED, claim, { origin: ctx.clientId });
  return claim;
}

async function release(ctx, claimId) {
  const claim = await claimsRepo.findById(db, claimId);
  if (!claim) throw new NotFoundError("That claim no longer exists.");

  await tx(async (t) => {
    await audit.record(t, audit.EVENTS.CLAIM_RELEASED, ctx, {
      target: { type: "claim", id: claimId, label: `${claim.accountName} ${claim.branch}` },
      detail: { serverId: claim.serverId, repos: claim.repos, source: claim.source }
    });
    await claimsRepo.remove(t, claimId);
  });

  await bus.emit(EVENTS.CLAIM_DELETED, { id: claimId }, { origin: ctx.clientId });
  return { ok: true };
}

/** Frees every claim on one environment, in one transaction and one event. */
async function releaseAllForServer(ctx, serverId) {
  const removed = await tx(async (t) => {
    const ids = await claimsRepo.listIdsByServer(t, serverId);
    if (!ids.length) return [];
    await audit.record(t, audit.EVENTS.CLAIM_RELEASED, ctx, {
      target: { type: "server", id: serverId },
      detail: { count: ids.length, reason: "force-free-server" }
    });
    await claimsRepo.removeMany(t, ids);
    return ids;
  });

  if (removed.length) {
    await bus.emit(
      EVENTS.CLAIMS_REPLACED,
      { serverId, claims: [] },
      { origin: ctx.clientId }
    );
  }
  return { ok: true, removed };
}

/**
 * Frees claims whose booked time has run out.
 *
 * Only when the deployment has asked for it: the other two expiry settings
 * ("remind", "remind-flag") are rendered by the browser from the same end time,
 * and freeing an environment nobody asked to free would be the worst possible
 * default.
 */
async function releaseExpired() {
  const settings = await settingsRepo.get(db);
  if (settings.onExpiry !== "auto-release") return { released: [] };

  const expired = await claimsRepo.listExpired(db, new Date());
  if (!expired.length) return { released: [] };

  const ids = expired.map((claim) => claim.id);
  await tx(async (t) => {
    await audit.record(t, audit.EVENTS.CLAIM_RELEASED, null, {
      detail: { count: ids.length, reason: "expired" }
    });
    await claimsRepo.removeMany(t, ids);
  });

  for (const id of ids) {
    await bus.emit(EVENTS.CLAIM_DELETED, { id });
  }
  return { released: ids };
}

async function list() {
  return claimsRepo.list(db);
}

module.exports = { create, release, releaseAllForServer, releaseExpired, list };
