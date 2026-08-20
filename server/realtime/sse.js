/**
 * Server-Sent Events: one long-lived response per watching tab.
 *
 * What this transport does that the previous one did not:
 *
 *   * sends deltas, not the whole board. The old implementation serialised
 *     every account, environment, claim and Jira issue on every change -- and
 *     the Jira poll counted as a change every twenty seconds whether anything
 *     had moved or not.
 *
 *   * re-checks authorization on every frame. A stream used to resolve its
 *     session once, at connect time, so deactivating someone left their open
 *     tab receiving the live board until they happened to reload.
 *
 *   * numbers every frame, so a browser can tell it missed one.
 */

const { EVENTS } = require("./events.js");
const bus = require("./bus.js");

// Comment frames, sent when nothing else is. Proxies and load balancers close
// a connection that has been silent for a minute or two, and a stream that
// dies silently looks to the user like a board that has stopped updating.
const HEARTBEAT_MS = 25_000;

class Stream {
  constructor(req, res, { sessionId, userId, clientIp }) {
    this.req = req;
    this.res = res;
    this.sessionId = sessionId;
    this.userId = userId;
    this.clientIp = clientIp;
    this.closed = false;
  }

  write(frame) {
    if (this.closed) return false;
    try {
      return this.res.write(frame);
    } catch (err) {
      this.close();
      return false;
    }
  }

  send(event) {
    return this.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  comment(text) {
    return this.write(`: ${text}\n\n`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch (err) {
      // already gone
    }
  }
}

class SseHub {
  /**
   * @param authorize  called with each stream before every frame. Returning
   *                   false drops it. This is where a revoked session or an
   *                   address removed from the allowlist takes effect.
   */
  constructor({ authorize }) {
    this.streams = new Set();
    this.authorize = authorize;
    this.unsubscribe = null;
    this.heartbeat = null;
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = bus.subscribe((event) => this.broadcast(event));
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) stream.comment("keep-alive");
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const stream of [...this.streams]) this.remove(stream);
  }

  /** Opens a stream and sends the board as its first frame. */
  add(req, res, context, snapshot) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "Connection": "keep-alive",
      // Tells nginx not to buffer the stream into uselessness.
      "X-Accel-Buffering": "no"
    });

    const stream = new Stream(req, res, context);
    this.streams.add(stream);

    // Retry hint for EventSource's own reconnect, then the board itself, so a
    // tab that has just connected has something to draw without waiting for
    // somebody else to change something.
    stream.write("retry: 3000\n\n");
    stream.send({
      v: 1,
      seq: snapshot.__seq ?? 0,
      type: EVENTS.SNAPSHOT,
      at: new Date().toISOString(),
      origin: null,
      payload: snapshot
    });

    const drop = () => this.remove(stream);
    req.on("close", drop);
    req.on("error", drop);
    res.on("error", drop);

    return stream;
  }

  remove(stream) {
    this.streams.delete(stream);
    stream.close();
  }

  async broadcast(event) {
    if (!this.streams.size) return;
    for (const stream of [...this.streams]) {
      let allowed = false;
      try {
        allowed = await this.authorize(stream);
      } catch (err) {
        allowed = false;
      }
      if (!allowed) {
        // The tab sees its stream drop and reconnects; that reconnect is
        // refused at the gate, and the page falls back to the sign-in screen.
        this.remove(stream);
        continue;
      }
      stream.send(event);
    }
  }

  get size() {
    return this.streams.size;
  }
}

module.exports = { SseHub, Stream };
