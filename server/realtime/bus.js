/**
 * The event bus.
 *
 * Services describe what changed; this turns that into a numbered, durable
 * event and hands it to whoever is listening (today: the SSE transport).
 *
 * Numbering happens in the database rather than in a module-level counter for
 * one reason: a counter restarts at zero when the process does, and a browser
 * holding sequence 4,812 would then be told the next event is number 1 and
 * would quietly conclude it had missed nothing. An AUTO_INCREMENT column cannot
 * lie about that.
 */

const { EventEmitter } = require("node:events");
const { db } = require("../db/client.js");
const boardEvents = require("../repositories/board-events.repo.js");

const emitter = new EventEmitter();
// One listener per open SSE stream, plus a little headroom. The default of 10
// would start printing leak warnings at the eleventh browser tab.
emitter.setMaxListeners(0);

/**
 * Appends an event and fans it out.
 *
 * Deliberately does not throw. A failure to record an event must not roll back
 * the change it describes -- the change is already committed and correct, and
 * the browsers' safety net is that any gap in the sequence makes them refetch.
 * So a failure here degrades the UI to "slightly late" rather than making a
 * successful write look like a failed one.
 */
async function emit(type, payload, { origin = null } = {}) {
  let seq = null;
  try {
    seq = await boardEvents.append(db, type, payload, origin);
  } catch (err) {
    console.error(`[bus] could not record ${type}: ${err.message}`);
    return null;
  }

  const event = { v: 1, seq, type, at: new Date().toISOString(), origin, payload };
  emitter.emit("event", event);
  return event;
}

/** Emits several events as one batch, so a caller does not have to await each. */
async function emitAll(events, { origin = null } = {}) {
  const emitted = [];
  for (const { type, payload } of events) {
    const event = await emit(type, payload, { origin });
    if (event) emitted.push(event);
  }
  return emitted;
}

function subscribe(listener) {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

module.exports = { emit, emitAll, subscribe };
