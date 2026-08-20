/**
 * Notes pinned to one repository of one environment.
 *
 * The smallest of the board writes and the clearest illustration of the
 * problem this rewrite fixes: this used to be a POST of the entire board --
 * every account, every environment, every claim, every Jira issue -- to record
 * one paragraph of text.
 */

const { db } = require("../db/client.js");
const notesRepo = require("../repositories/notes.repo.js");
const serversRepo = require("../repositories/servers.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const { NotFoundError } = require("../http/errors.js");

async function set(ctx, serverId, repoName, text) {
  const server = await serversRepo.findById(db, serverId);
  if (!server || !server.repos[repoName]) {
    throw new NotFoundError("That repository was not found on this environment.");
  }

  const result = await notesRepo.set(db, serverId, repoName, text, ctx.user.id);

  await bus.emit(
    result.removed ? EVENTS.NOTE_CLEARED : EVENTS.NOTE_SET,
    { serverId, repoName, text: result.body },
    { origin: ctx.clientId }
  );

  return { ok: true, text: result.body };
}

module.exports = { set };
