/**
 * The board projection and the live stream.
 *
 * GET /api/state stays a single request returning the bare appData object --
 * byte-identical in shape to what this application has always served, so a
 * fresh page load costs exactly what it always cost. Every write that used to
 * ride along inside a full-board POST now has its own route file next to this
 * one.
 */

const boardService = require("../services/board.service.js");
const sessionService = require("../services/session.service.js");

async function getState() {
  const board = await boardService.load();
  const { __seq, ...body } = board;
  return body;
}

/**
 * Opens an SSE stream. Handled directly rather than through the normal
 * handler return, because a stream does not return a JSON body -- it takes
 * over the response and keeps it open.
 */
function makeStreamHandler(hub) {
  return async function stream(ctx) {
    const board = await boardService.load();
    hub.add(ctx.req, ctx.res, {
      sessionId: ctx.session.id,
      userId: ctx.user.id,
      clientIp: ctx.clientIp
    }, board);
    // No return value: the response has already been written and is being
    // held open. The route table still needs a handler that resolves,
    // because the pipeline awaits it -- resolving with undefined is correct,
    // the pipeline only serialises a body when the handler returns one.
    return undefined;
  };
}

module.exports = { getState, makeStreamHandler };
