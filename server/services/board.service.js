/**
 * The board projection, cached.
 *
 * GET /api/state has to stay a single request -- that is the whole point of
 * keeping it around after the per-entity endpoints exist -- so the projection
 * is cached and only rebuilt when the event log says something changed since
 * it was taken. A reconnect storm (a deploy, a network blip that drops every
 * open tab at once) then costs one query total, not one per tab.
 */

const boardRepo = require("../repositories/board.repo.js");
const bus = require("../realtime/bus.js");

let cached = null;
let cachedAtSeq = -1;

bus.subscribe(() => {
  // Invalidate rather than recompute inline: a burst of writes should not each
  // pay for a fresh projection nobody has asked to see yet.
  cachedAtSeq = -1;
});

async function load() {
  const fresh = await boardRepo.load();
  if (fresh.__seq === cachedAtSeq && cached) return cached;
  cached = fresh;
  cachedAtSeq = fresh.__seq;
  return cached;
}

module.exports = { load };
