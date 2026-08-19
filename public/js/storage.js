/**
 * Persistence layer. Everything above this file (state.js) talks to
 * Storage's load()/save()/subscribeRemote() only.
 *
 * When served by server.js, state lives on that server and is pushed to
 * every open tab over Server-Sent Events — that's what makes assign/edit/
 * release show up live for other viewers (e.g. over VS Code Live Share).
 * When opened directly as a file (no server), the network calls fail
 * silently and everything falls back to a plain per-browser localStorage,
 * same as before.
 */

const Storage = (() => {
  const LOCAL_KEY = "serverManager.appData.v1";

  // A role without the `claim` capability may look but not touch. Their
  // browser still keeps a local cache — filters and the like run through
  // the same notify() — it just never pushes any of it back.
  let readOnly = false;
  function setReadOnly(value) { readOnly = !!value; }

  function cacheLocally(appData) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(appData));
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

  function save(appData) {
    cacheLocally(appData);
    if (readOnly) return;
    fetch("/api/state", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appData)
    }).then((res) => {
      if (res.status === 401) location.reload();
    }).catch(() => {
      // no server running — localStorage cache above is already the source of truth
    });
  }

  // Fire-and-forget nudge for server.js to run a Jira sync pass right now
  // instead of waiting for its next scheduled tick — used right after
  // adding a new environment, so an already-existing matching ticket
  // populates immediately. A no-op (silently ignored) with no server
  // running.
  function nudgeJiraSync() {
    fetch("/api/jira/sync-now", { method: "POST" }).catch(() => {});
  }

  /**
   * Subscribes to live updates pushed by other viewers connected to the same
   * server.js instance. onUpdate receives the full appData whenever it
   * changes remotely. onStatusChange("connected" | "offline") reflects
   * whether we're actually talking to a shared server right now.
   */
  function subscribeRemote(onUpdate, onStatusChange) {
    if (typeof EventSource === "undefined") {
      onStatusChange("offline");
      return;
    }

    const source = new EventSource("/api/events");

    source.onopen = () => onStatusChange("connected");
    source.onerror = () => onStatusChange("offline");

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        cacheLocally(data);
        onUpdate(data);
      } catch (err) {
        // ignore malformed push
      }
    };
  }

  return { load, save, setReadOnly, subscribeRemote, nudgeJiraSync };
})();
