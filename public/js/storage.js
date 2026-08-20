/**
 * Persistence layer. Everything above this file (state.js) talks to
 * Storage's load()/mutate()/subscribeRemote() only.
 *
 * The board used to be one object, POSTed in full on every single change —
 * a note edit sent every account, every environment, every claim and every
 * Jira issue back to the server, and the server pushed the same full object
 * to every other open tab in return. `mutate()` below replaces that with one
 * small request per change, to the specific endpoint for that change; the
 * server now tells other tabs only what actually moved (see state.js's
 * REDUCERS), not the whole board every time.
 *
 * GET /api/state remains a single request for the initial load — there was
 * never a reason to split that one up, only the writes.
 */

const Storage = (() => {
  const LOCAL_KEY = "serverManager.appData.v1";

  // A role without the `claim` capability may look but not touch. Their
  // browser still keeps a local cache — filters and the like run through
  // the same notify() — it just never pushes any of it back.
  let readOnly = false;
  function setReadOnly(value) { readOnly = !!value; }

  // The cache is what this browser falls back to with no server: the board
  // as configured, not what Jira said a while ago. Leaving the sync's own
  // lists out of it keeps a save small — they are most of the payload, and
  // they would be stale by the time anything read them back.
  function cacheLocally(appData) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(withoutJiraDerived(appData)));
    } catch (err) {
      // storage full/unavailable — remote sync (if any) still works
    }
  }

  function loadLocalFallback() {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.users && parsed.accounts && parsed.servers) {
          if (!parsed.assignments) parsed.assignments = [];
          return parsed;
        }
      } catch (err) {
        // fall through to seed
      }
    }
    const seeded = buildDefaultAppData();
    cacheLocally(seeded);
    return seeded;
  }

  async function load() {
    try {
      const res = await fetch("/api/state", { credentials: "same-origin" });
      // The session ended between the auth check and this call. Falling
      // back to the local cache would quietly show a stale board as if it
      // were live; a reload lands on the sign-in screen instead.
      if (res.status === 401) { location.reload(); return new Promise(() => {}); }
      if (!res.ok) throw new Error(`bad response: ${res.status}`);
      const data = await res.json();
      cacheLocally(data);
      return data;
    } catch (err) {
      return loadLocalFallback();
    }
  }

  /**
   * The one function every State mutator calls to actually reach the server:
   * a JSON request to one endpoint for one change, carrying the session
   * cookie and the CSRF header Auth already tracks.
   *
   * Returns `{ok, ...}` — the same shape a mutator has always returned to its
   * caller — so State's mutators can await this and hand the result straight
   * back with no change to what a UI file reads.
   */
  async function mutate(method, path, body) {
    if (readOnly) return { ok: false, error: "Read-only." };
    try {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(Auth ? Auth.csrfHeader(method) : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (res.status === 401) { location.reload(); return new Promise(() => {}); }
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ...data };
    } catch (err) {
      // No server reachable. The optimistic local update the caller already
      // applied stands as the best guess until a connection comes back and
      // the next SSE snapshot reconciles it.
      return { ok: false, error: "Couldn't reach the server.", offline: true };
    }
  }

  // Fire-and-forget nudge for the server to run a Jira sync pass right now
  // instead of waiting for its next scheduled tick — used right after
  // adding a new environment, so an already-existing matching ticket
  // populates immediately. A no-op (silently ignored) with no server
  // running.
  function nudgeJiraSync() {
    fetch("/api/jira/sync-now", {
      method: "POST",
      credentials: "same-origin",
      headers: Auth ? Auth.csrfHeader("POST") : {}
    }).catch(() => {});
  }

  /**
   * Subscribes to live updates pushed by other viewers connected to the same
   * server instance. onEvent receives each event as it arrives — state.js
   * applies it through the matching reducer. onStatusChange("connected" |
   * "offline") reflects whether we're actually talking to a shared server
   * right now.
   */
  function subscribeRemote(onEvent, onStatusChange) {
    if (typeof EventSource === "undefined") {
      onStatusChange("offline");
      return;
    }

    const source = new EventSource("/api/events");

    source.onopen = () => onStatusChange("connected");
    source.onerror = () => onStatusChange("offline");

    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch (err) {
        // ignore malformed push
      }
    };
  }

  return { load, mutate, cacheLocally, setReadOnly, subscribeRemote, nudgeJiraSync };
})();
