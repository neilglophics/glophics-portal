/**
 * The board as the process holds it, plus the two things everything does to
 * it: save it, and tell every open tab.
 *
 * `Board.state` is deliberately a property rather than an exported binding.
 * POST /api/state replaces the whole board in one assignment, and routes and
 * jobs in four other files have to see that replacement — a plain `let`
 * exported by value would leave each of them holding the object that was
 * current when they were required.
 *
 * Loading happens here, at require time, because there is exactly one board
 * per process and every module that wants it wants it already loaded. Order
 * of requires in index.js therefore does not matter.
 */

const StateStore = require("./state-store.js");
const IpAllowlist = require("./ip-allowlist.js");

const Board = {
  state: StateStore.load(),

  // Open Server-Sent Events responses, one per tab watching the board.
  sseClients: new Set(),

  /**
   * Coalescing, the per-section skip-if-unchanged check, and the atomic
   * rename all live in state-store.js. This stays a named function because
   * its callers read better for it.
   */
  persist() {
    StateStore.save();
  },

  broadcast() {
    const payload = `data: ${JSON.stringify(Board.state)}\n\n`;
    for (const res of Board.sseClients) {
      // An SSE stream is opened once and then lives for hours, so it would
      // otherwise keep feeding live state to an address that was taken off
      // the allowlist an hour ago. Re-check on the way out; the tab sees a
      // dropped connection and its reconnect is refused at the gate.
      if (!IpAllowlist.allows(res.req)) {
        Board.sseClients.delete(res);
        res.end();
        continue;
      }
      res.write(payload);
    }
  }
};

// The store writes whatever this returns, asked afresh on every save — a save
// coalesced behind an in-flight one has to write the board as it is by then,
// not the one that triggered it.
StateStore.attach(() => Board.state);

module.exports = Board;
