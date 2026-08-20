/**
 * Central state + mutations. UI code never touches Storage or appData
 * directly — it calls State.* and subscribes to State.subscribe() to know
 * when to re-render.
 *
 * Occupancy is derived, not stored on the server. appData.tickets holds
 * every *active claim* — a ticket (synced from Jira, or created manually
 * via "Assign") currently occupying one or more specific repos on one
 * specific environment. Several claims can exist for the same server at
 * once (different tickets, different repos — a "partly free" server), and
 * more than one claim can touch the same repo ("Shared"). Which statuses
 * start/end a jira-sourced claim is the server's Jira sync job; this file
 * only reads/writes the resulting list.
 *
 * Every mutator below follows the same shape: validate with the rules in
 * shared/rules.js (the exact functions the server runs too, so the two
 * cannot silently disagree), apply the change to the local appData and
 * repaint immediately, then tell the server in the background through
 * Storage.mutate(). That last step used to be "POST the entire board" —
 * every account, every environment, every claim, every Jira issue — for a
 * single note edit; now it is one small request to the endpoint for that one
 * change, and the server tells other open tabs only what actually moved.
 *
 * A mutator's return value is still synchronous — every UI file reads
 * `{ok, errors}` on the same line it calls one of these — because the
 * validation that produces it runs locally, before anything is sent. If the
 * server rejects a request that passed local validation (a genuine race with
 * another tab, most likely), the mismatch is corrected by the next event or
 * snapshot rather than by the caller, which already has its answer.
 */

const State = (() => {
  let appData = null;
  let syncStatus = "offline";
  let lastSeq = null;

  const filters = {
    status: "all",
    userId: "all",
    accountId: "all",
    search: ""
  };

  const listeners = [];
  const statusListeners = [];

  function subscribe(fn) {
    listeners.push(fn);
  }
  function subscribeStatus(fn) {
    statusListeners.push(fn);
  }

  // Repaints. No network call — that is the whole point of splitting this
  // out from the old notify()/save() pair. View-only changes (filters) call
  // only this; changes to real data call this and Storage.mutate() both.
  function render() {
    listeners.forEach((fn) => fn());
  }

  /**
   * A background write failed after the local state already assumed it
   * would succeed. Rather than try to hand-unwind one optimistic edit out of
   * whatever else has happened since, pull the current truth and repaint —
   * the same recovery a missed SSE event uses.
   */
  async function resync() {
    appData = await Storage.load();
    lastSeq = appData.__seq ?? null;
    render();
  }

  function warnMutationFailed(action, result) {
    console.warn(`[state] ${action} was not saved: ${(result && (result.error || (result.errors || [])[0])) || "unknown error"}`);
  }

  async function send(action, method, path, body) {
    const result = await Storage.mutate(method, path, body);
    if (!result.ok && !result.offline) {
      warnMutationFailed(action, result);
      await resync();
    }
    return result;
  }

  // ---------- realtime ----------

  function upsertById(list, item) {
    const index = list.findIndex((x) => x.id === item.id);
    if (index === -1) list.push(item);
    else list[index] = item;
  }

  function removeById(list, id) {
    const index = list.findIndex((x) => x.id === id);
    if (index !== -1) list.splice(index, 1);
  }

  // One entry per event type this server can send. A type with no entry
  // here — including any future one this build predates — falls through to
  // a full resync, which is always correct, just not the cheapest path.
  const REDUCERS = {
    "board.snapshot": (payload) => { appData = payload; },
    "board.invalidate": () => { /* handled by the fallback below */ },

    "directory-user.upserted": (payload) => upsertById(appData.users, payload),
    "directory-user.deleted": (payload) => removeById(appData.users, payload.id),

    "account.upserted": (payload) => upsertById(appData.accounts, payload),
    "account.deleted": (payload) => removeById(appData.accounts, payload.id),

    "server.upserted": (payload) => upsertById(appData.servers, payload),
    "server.deleted": (payload) => removeById(appData.servers, payload.id),

    "server-repo.health": (payload) => {
      (payload.changes || []).forEach((change) => {
        const server = getServer(change.serverId);
        if (server && server.repos[change.repoName]) {
          server.repos[change.repoName].health = change.health;
        }
      });
    },

    "note.set": (payload) => { appData.notes[getRepoNoteKey(payload.serverId, payload.repoName)] = payload.text; },
    "note.cleared": (payload) => { delete appData.notes[getRepoNoteKey(payload.serverId, payload.repoName)]; },

    "claim.created": (payload) => upsertById(appData.tickets, payload),
    "claim.updated": (payload) => upsertById(appData.tickets, payload),
    "claim.deleted": (payload) => removeById(appData.tickets, payload.id),
    "claims.replaced": (payload) => {
      appData.tickets = appData.tickets.filter((t) => t.serverId !== payload.serverId).concat(payload.claims);
    },

    "settings.updated": (payload) => { appData.settings = payload; },

    "jira.heartbeat": (payload) => { appData.lastJiraSyncAt = payload.lastJiraSyncAt; },
    "jira.synced": (payload) => {
      appData.lastJiraSyncAt = payload.lastJiraSyncAt;
      const issues = payload.issues || { upserted: [], removed: [] };
      const skipped = payload.skipped || { upserted: [], removed: [] };
      appData.jiraIssues = appData.jiraIssues || [];
      appData.jiraSkipped = appData.jiraSkipped || [];
      issues.upserted.forEach((issue) => upsertByKey(appData.jiraIssues, issue));
      (issues.removed || []).forEach((key) => removeByKey(appData.jiraIssues, key));
      skipped.upserted.forEach((entry) => upsertByKey(appData.jiraSkipped, entry));
      (skipped.removed || []).forEach((key) => removeByKey(appData.jiraSkipped, key));
    }
  };

  function upsertByKey(list, item) {
    const index = list.findIndex((x) => x.key === item.key);
    if (index === -1) list.push(item);
    else list[index] = item;
  }
  function removeByKey(list, key) {
    const index = list.findIndex((x) => x.key === key);
    if (index !== -1) list.splice(index, 1);
  }

  /**
   * Applies one event from the SSE stream. A gap in `seq` or an event type
   * this build does not recognise both mean the same thing — this tab's copy
   * of the board can no longer be trusted to be a diff away from correct —
   * so both fall back to fetching the whole thing, same as a fresh page load.
   */
  function applyEvent(event) {
    if (lastSeq !== null && event.seq !== null && event.seq !== lastSeq + 1 && event.type !== "board.snapshot") {
      resync();
      return;
    }
    if (event.seq !== null && event.seq !== undefined) lastSeq = event.seq;

    if (event.type === "board.invalidate") {
      resync();
      return;
    }

    const reduce = REDUCERS[event.type];
    if (!reduce) {
      resync();
      return;
    }
    reduce(event.payload);
    render();
  }

  function setSyncStatus(status) {
    syncStatus = status;
    statusListeners.forEach((fn) => fn(status));
  }

  function getSyncStatus() { return syncStatus; }

  async function init() {
    appData = await Storage.load();
    lastSeq = appData.__seq ?? null;
    // The server only ever hands back the current shape now, but a browser
    // that still has yesterday's build cached (or the localStorage fallback,
    // which predates this) may not — migrateAppData is idempotent, so this
    // costs nothing when there is nothing to upgrade.
    if (migrateAppData(appData)) render();
    Storage.subscribeRemote(applyEvent, setSyncStatus);
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ---------- getters ----------

  function getUsers() { return appData.users; }
  function getAccounts() { return appData.accounts; }
  function getServers() { return appData.servers; }
  function getSettings() { return appData.settings; }
  function getSkippedTickets() { return appData.jiraSkipped || []; }

  // Every ticket the last sync saw that is not holding a repository — the
  // rest of the board, at whatever status Jira has it at. Claims live in
  // appData.tickets; these are everything else, and the two never overlap.
  function getJiraIssues() { return appData.jiraIssues || []; }

  // Tickets Jira matched to this environment that are not at an occupying
  // status — they're on the branch but hold no repo. Read off the board
  // with the same rule the sync claims by, so the two cannot disagree.
  function getWaitingTickets(serverId) {
    const jira = getSettings().jira;
    return getJiraIssues().filter((t) =>
      t.serverId === serverId &&
      !statusIn(jira.occupyingStatuses, t.status) &&
      !statusIn(jira.releasingStatuses, t.status) &&
      !statusIn(JIRA_TERMINAL_STATUSES, t.status));
  }
  function getLastJiraSyncAt() { return appData.lastJiraSyncAt || null; }

  function getUser(id) { return appData.users.find((u) => u.id === id) || null; }
  function getAccount(id) { return appData.accounts.find((a) => a.id === id) || null; }
  function getServer(id) { return appData.servers.find((s) => s.id === id) || null; }

  function signedInIdentityValues() {
    const authUser = typeof Auth !== "undefined" ? Auth.user() : null;
    return authUser ? [authUser.id, authUser.username, authUser.displayName, ...(authUser.jiraNames || [])]
      .filter(Boolean).map((value) => String(value).trim().toLowerCase()) : [];
  }

  function getSignedInUserId() {
    const values = signedInIdentityValues();
    if (!values.length) return null;
    const user = appData.users.find((candidate) =>
      [candidate.id, candidate.name].some((value) => values.includes(String(value).trim().toLowerCase()))
    );
    return user ? user.id : "__me__";
  }

  function claimMatchesFilterUser(claim, userId) {
    const user = userId === "__me__" ? null : getUser(userId);
    const values = userId === "__me__"
      ? signedInIdentityValues()
      : [userId, user?.name, ...(user?.jiraNames || [])]
        .filter(Boolean).map((value) => String(value).trim().toLowerCase());
    if ((claim.userIds || []).some((id) => values.includes(String(id).trim().toLowerCase()))) return true;
    const people = (claim.userIds || []).map((id) => getUser(id)?.name || id)
      .concat(claim.rawAssignees || []);
    return people.some((person) => values.includes(String(person).trim().toLowerCase()));
  }

  function getRepositoriesForAccount(accountId) {
    const account = getAccount(accountId);
    return account ? account.repositories : [];
  }

  function getFilters() { return { ...filters }; }

  // ---------- claims ----------

  function getServerTickets(serverId) {
    return appData.tickets.filter((t) => t.serverId === serverId);
  }

  function getRepoClaims(serverId, repoName) {
    return getServerTickets(serverId).filter((t) => t.repos.includes(repoName));
  }

  function getTicket(ticketId) {
    return appData.tickets.find((t) => t.id === ticketId) || null;
  }

  function getRepoNoteKey(serverId, repoName) { return `${serverId}::${repoName}`; }
  function getRepoNote(serverId, repoName) { return appData.notes[getRepoNoteKey(serverId, repoName)] || ""; }

  function setRepoNote(serverId, repoName, text) {
    const key = getRepoNoteKey(serverId, repoName);
    const trimmed = (text || "").trim();
    if (trimmed) appData.notes[key] = trimmed;
    else delete appData.notes[key];
    render();
    send("setRepoNote", "PUT",
      `/api/servers/${encodeURIComponent(serverId)}/repos/${encodeURIComponent(repoName)}/note`,
      { text: trimmed });
  }

  // Any offline repo takes priority over claim state — "Needs attention"
  // matters more than whether it's booked. Otherwise: no repo claimed at
  // all is "free", every repo claimed is "inuse", anything in between
  // (some claimed, some not) is "partial" ("partly free").
  function getDisplayStatus(server) {
    const repoNames = Object.keys(server.repos);
    if (repoNames.some((r) => server.repos[r].health === "offline")) return "issue";
    const claimedRepos = new Set(getServerTickets(server.id).flatMap((t) => t.repos));
    if (claimedRepos.size === 0) return "free";
    if (repoNames.every((r) => claimedRepos.has(r))) return "inuse";
    return "partial";
  }

  function getFilteredServers() {
    const search = filters.search.trim().toLowerCase();
    return appData.servers.filter((server) => {
      if (filters.status !== "all" && getDisplayStatus(server) !== filters.status) return false;
      const claims = getServerTickets(server.id);
      if (filters.userId !== "all" && !claims.some((t) => claimMatchesFilterUser(t, filters.userId))) return false;
      if (filters.accountId !== "all" && server.accountId !== filters.accountId) return false;

      if (search) {
        const account = getAccount(server.accountId);
        const userNames = claims.flatMap((t) => t.userIds).map((id) => getUser(id)?.name || "").join(" ");
        const repoUrls = Object.values(server.repos).map((r) => r.url).join(" ");
        const ticketIds = claims.map((t) => t.id).join(" ");
        const summaries = claims.map((t) => t.summary || "").join(" ");
        const notesText = Object.keys(appData.notes)
          .filter((k) => k.startsWith(`${server.id}::`))
          .map((k) => appData.notes[k]).join(" ");
        const haystack = [
          server.name, repoUrls, userNames,
          account ? account.displayName : "",
          Object.keys(server.repos).join(" "),
          ticketIds, summaries, notesText
        ].join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function getSummary() {
    const servers = appData.servers;
    let free = 0, partial = 0, needsAttention = 0;
    const peopleSet = new Set();
    const countedTicketIds = new Set();
    let ticketsCount = 0;
    let freeingSoon = 0;

    servers.forEach((server) => {
      const repoNames = Object.keys(server.repos);
      if (repoNames.some((r) => server.repos[r].health === "offline")) needsAttention++;

      const claims = getServerTickets(server.id);
      const claimedRepos = new Set(claims.flatMap((t) => t.repos));
      if (claimedRepos.size === 0) free++;
      else if (!repoNames.every((r) => claimedRepos.has(r))) partial++;

      claims.forEach((t) => {
        t.userIds.forEach((id) => peopleSet.add(id));
        if (!countedTicketIds.has(t.id)) { countedTicketIds.add(t.id); ticketsCount++; }
        if (t.endTime) {
          const msLeft = new Date(t.endTime).getTime() - Date.now();
          if (msLeft > 0 && msLeft < 2 * 60 * 60 * 1000) freeingSoon++;
        }
      });
    });

    const inuseTotal = servers.length - free;
    return { total: servers.length, free, partial, inuse: inuseTotal, needsAttention, ticketsCount, peopleCount: peopleSet.size, freeingSoon };
  }

  // ---------- filter mutations ----------
  //
  // Pure view state — never sent to the server. Before this rewrite these
  // went through the same notify() as everything else, which meant a
  // dropdown click or a keystroke in the search box posted the entire board.

  function setFilter(key, value) {
    filters[key] = value;
    render();
  }

  function clearFilters() {
    filters.status = "all";
    filters.userId = "all";
    filters.accountId = "all";
    filters.search = "";
    render();
  }

  // ---------- claim actions ----------
  //
  // Validated by shared/rules.js — the same functions server/services runs —
  // so a client-side pass and the server's authoritative one can only ever
  // agree, never quietly drift apart.

  // Creates a claim on specific repos of a specific environment. If a real
  // ticket key is given it's tagged source:"jira" so the Jira sync takes it
  // over from here (refreshing its status/summary, auto-freeing it once
  // the ticket reaches a releasing status) — otherwise it's a plain manual
  // claim that only a person (via Force free) can end.
  function addClaim(serverId, payload) {
    const server = getServer(serverId);
    if (!server) return { ok: false, errors: ["Server not found."] };

    const repoKeys = Object.keys(server.repos);
    const repos = (payload.repos || []).filter((r) => repoKeys.includes(r));
    const jiraTicket = payload.jiraTicket ? payload.jiraTicket.trim().toUpperCase() : null;

    const errors = validateClaim(appData, { ...payload, repos, jiraTicket });
    if (errors.length) return { ok: false, errors };

    const account = getAccount(server.accountId);
    // Minted once, used both for the optimistic local copy and sent to the
    // server as `id` -- so the eventual claim.created event (which echoes
    // back whatever id the record was actually stored under) updates this
    // same entry instead of arriving as what looks like a second claim.
    const manualClaimId = jiraTicket || uid("manual");
    const ticket = {
      id: manualClaimId,
      source: jiraTicket ? "jira" : "manual",
      serverId: server.id,
      accountName: account ? account.displayName : "",
      branch: server.name,
      repos,
      userIds: payload.userIds,
      rawAssignees: [],
      status: jiraTicket ? (payload.jiraStatus || "Pending sync") : "Manual",
      summary: payload.summary || null,
      note: payload.note ? payload.note.trim() : null,
      startTime: payload.startTime,
      endTime: payload.endTime,
      claimedAt: new Date().toISOString(),
      lastSyncedAt: null
    };
    appData.tickets.push(ticket);
    render();
    send("addClaim", "POST", "/api/claims", { serverId, ...payload, repos, jiraTicket, id: manualClaimId });
    return { ok: true, ticket };
  }

  function forceFreeTicket(ticketId) {
    appData.tickets = appData.tickets.filter((t) => t.id !== ticketId);
    render();
    send("forceFreeTicket", "DELETE", `/api/claims/${encodeURIComponent(ticketId)}`);
  }

  function forceFreeServer(serverId) {
    appData.tickets = appData.tickets.filter((t) => t.serverId !== serverId);
    render();
    send("forceFreeServer", "DELETE", `/api/servers/${encodeURIComponent(serverId)}/claims`);
  }

  // ---------- config CRUD (settings) ----------

  // Validated on the same rules as updateServer, so the add form and the
  // edit form reject exactly the same input.
  function addServer({ name, accountId, repoUrls }) {
    const errors = validateServer(appData, null, { name, accountId });
    if (errors.length) return { ok: false, errors };

    const account = getAccount(accountId);
    const nextName = (name || "").trim();
    // Minted once, used for both the optimistic local copy and the request --
    // see the matching comment in addClaim for why this has to be one id,
    // not one guessed independently on each side.
    const nextServerId = uid("server");
    const repos = {};
    getRepositoriesForAccount(account.id).forEach((repoName) => {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      repos[repoName] = { url, health: url ? "checking" : "unconfigured" };
    });
    appData.servers.push({ id: nextServerId, name: nextName, accountId: account.id, repos });
    render();
    send("addServer", "POST", "/api/servers", { id: nextServerId, name: nextName, accountId: account.id, repoUrls });
    // A ticket for this exact account+environment may already be sitting in
    // Jira — nudge an immediate sync so it populates right away instead of
    // waiting for the next poll tick.
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  function removeServer(serverId) {
    appData.servers = appData.servers.filter((s) => s.id !== serverId);
    appData.tickets = appData.tickets.filter((t) => t.serverId !== serverId);
    Object.keys(appData.notes).forEach((k) => { if (k.startsWith(`${serverId}::`)) delete appData.notes[k]; });
    render();
    send("removeServer", "DELETE", `/api/servers/${encodeURIComponent(serverId)}`);
  }

  // An environment's name is the "Branch" Jira matches on, and its account
  // decides which repo slots it carries — so an edit ripples the same way
  // an account edit does: claims recorded under the old name/account are
  // rewritten, and repos the new account doesn't have take their urls,
  // notes and claims with them.
  function updateServer(serverId, { name, accountId, repoUrls }) {
    const server = getServer(serverId);
    if (!server) return { ok: false, errors: ["Environment not found."] };

    const nextAccountId = accountId || server.accountId;
    const errors = validateServer(appData, serverId, { name, accountId: nextAccountId });
    if (errors.length) return { ok: false, errors };

    const nextName = (name || "").trim();
    const account = getAccount(nextAccountId);
    const repoNames = account.repositories;
    const removedRepos = Object.keys(server.repos).filter((r) => !repoNames.includes(r));

    server.name = nextName;
    server.accountId = nextAccountId;

    repoNames.forEach((repoName) => {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      // An untouched url keeps the health the server last measured for it —
      // only a changed one goes back to "checking".
      if (server.repos[repoName] && server.repos[repoName].url === url) return;
      server.repos[repoName] = { url, health: url ? "checking" : "unconfigured" };
    });
    removedRepos.forEach((repoName) => {
      delete server.repos[repoName];
      delete appData.notes[getRepoNoteKey(serverId, repoName)];
    });

    appData.tickets = appData.tickets.filter((t) => {
      if (t.serverId !== serverId) return true;
      t.accountName = account.displayName;
      t.branch = nextName;
      t.repos = t.repos.filter((r) => repoNames.includes(r));
      // A claim that held only dropped repos no longer occupies anything.
      return t.repos.length > 0;
    });

    render();
    send("updateServer", "PATCH", `/api/servers/${encodeURIComponent(serverId)}`, { name: nextName, accountId: nextAccountId, repoUrls });
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  function updateServerRepoUrl(serverId, repoName, url) {
    const server = getServer(serverId);
    if (!server || !server.repos[repoName]) return;
    server.repos[repoName].url = url;
    server.repos[repoName].health = "checking";
    render();
    send("updateServerRepoUrl", "PUT",
      `/api/servers/${encodeURIComponent(serverId)}/repos/${encodeURIComponent(repoName)}/url`,
      { url });
  }

  // ---------- Jira label matching (shared logic lives in data.js; reused
  // here by the Assign modal's ticket autofill) ----------

  // Referenced via `window.` — this file defines its own same-named wrapper
  // below, so the bare identifier would otherwise resolve to itself.
  function matchRepositoriesToKeys(labels, validKeys) {
    return window.matchRepositoriesToKeys(labels, validKeys);
  }

  function matchUserIdsByLabels(labels) {
    return window.matchUserIdsByLabels(labels, appData.users);
  }

  // ---------- users ----------

  // ---------- users (the directory) ----------

  // Same rules as updateUser below — the Jira names are what the next sync
  // matches Jira's assignee labels against, so they have to be unique.
  function addUser({ name, role, jiraNames }) {
    const errors = validateDirectoryUser(appData, null, { name, role, jiraNames });
    if (errors.length) return { ok: false, errors };

    const nextName = (name || "").trim();
    const nextRole = (role || "").trim();
    const nextJiraNames = normalizeJiraNames(jiraNames, nextName);
    // Minted once, used for both the optimistic local copy and the request --
    // see the matching comment in addClaim.
    const nextUserId = uid("user");

    appData.users.push({ id: nextUserId, name: nextName, role: nextRole, jiraNames: nextJiraNames });
    render();
    send("addUser", "POST", "/api/directory/users", { id: nextUserId, name: nextName, role: nextRole, jiraNames: nextJiraNames });
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  // A user's Jira names are what "Ticket Assignee" labels are matched
  // against (data.js matchUserIdsByLabels), so editing them changes who the
  // next sync resolves a ticket to. Claims reference users by id, so the
  // ones already on the board follow a rename on their own.
  function updateUser(userId, { name, role, jiraNames }) {
    const user = getUser(userId);
    if (!user) return { ok: false, errors: ["User not found."] };

    const errors = validateDirectoryUser(appData, userId, {
      name, role, jiraNames: jiraNames === undefined ? user.jiraNames : jiraNames
    });
    if (errors.length) return { ok: false, errors };

    const nextName = (name || "").trim();
    const nextRole = (role || "").trim();
    const nextJiraNames = normalizeJiraNames(
      jiraNames === undefined ? user.jiraNames : jiraNames, nextName);

    user.name = nextName;
    user.role = nextRole;
    user.jiraNames = nextJiraNames;
    render();
    send("updateUser", "PATCH", `/api/directory/users/${encodeURIComponent(userId)}`,
      { name: nextName, role: nextRole, jiraNames: nextJiraNames });
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  function removeUser(userId) {
    appData.users = appData.users.filter((u) => u.id !== userId);
    render();
    send("removeUser", "DELETE", `/api/directory/users/${encodeURIComponent(userId)}`);
  }

  // The id is a slug of the display name unless one is passed explicitly,
  // so callers only have to collect the name people actually type.
  function addAccount({ id, displayName, repositories }) {
    const nextName = (displayName || "").trim();
    // Slugged even when an id is supplied explicitly — nothing in the UI
    // currently supplies one, but the rule has always applied regardless.
    const nextId = (id || nextName).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const nextRepos = [...new Set((repositories || []).map((r) => r.trim()).filter(Boolean))];

    // Validated against the id this call will actually apply — not
    // re-derived from the raw inputs by shared/rules.js, which would use a
    // different fallback the moment `id` is provided.
    const errors = validateAccount(appData, null, { id: nextId, displayName, repositories });
    if (errors.length) return { ok: false, errors };

    appData.accounts.push({ id: nextId, displayName: nextName, repositories: nextRepos });
    render();
    send("addAccount", "POST", "/api/accounts", { id: nextId, displayName: nextName, repositories: nextRepos });
    return { ok: true, id: nextId };
  }

  // Editing an account ripples outward: its displayName is what Jira
  // tickets are matched on (data.js findServerForTicket) and what active
  // claims recorded, and its repository list defines the per-repo slots
  // every environment under it carries. Repos added here appear
  // unconfigured on those environments; repos dropped here take their
  // urls, notes and claims with them.
  function updateAccount(accountId, { id, displayName, repositories }) {
    const account = getAccount(accountId);
    if (!account) return { ok: false, errors: ["Account not found."] };

    // The edit form never supplies `id`, so this is ordinarily just
    // `accountId` unchanged — a rename never touches the id. Computed before
    // validation so shared/rules.js checks the id this call will actually
    // apply, not one it would derive from displayName under its own default.
    const nextId = (id || accountId).trim().toLowerCase().replace(/\s+/g, "-");
    const nextName = (displayName || "").trim();

    const errors = validateAccount(appData, accountId, { id: nextId, displayName, repositories });
    if (errors.length) return { ok: false, errors };
    const nextRepos = [...new Set((repositories || []).map((r) => r.trim()).filter(Boolean))];

    const servers = appData.servers.filter((s) => s.accountId === accountId);
    const removedRepos = account.repositories.filter((r) => !nextRepos.includes(r));

    account.id = nextId;
    account.displayName = nextName;
    account.repositories = nextRepos;

    servers.forEach((server) => {
      server.accountId = nextId;
      nextRepos.forEach((repoName) => {
        if (!server.repos[repoName]) server.repos[repoName] = { url: "", health: "unconfigured" };
      });
      removedRepos.forEach((repoName) => {
        delete server.repos[repoName];
        delete appData.notes[getRepoNoteKey(server.id, repoName)];
      });
    });

    const serverIds = new Set(servers.map((s) => s.id));
    appData.tickets = appData.tickets.filter((t) => {
      if (!serverIds.has(t.serverId)) return true;
      t.accountName = nextName;
      t.repos = t.repos.filter((r) => nextRepos.includes(r));
      // A claim that held only dropped repos no longer occupies anything.
      return t.repos.length > 0;
    });

    if (filters.accountId === accountId) filters.accountId = nextId;

    render();
    send("updateAccount", "PATCH", `/api/accounts/${encodeURIComponent(accountId)}`,
      { id: nextId, displayName: nextName, repositories: nextRepos });
    // A renamed account may match Jira tickets it didn't before — same
    // reasoning as addServer(): sync now instead of at the next poll tick.
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  function removeAccount(accountId) {
    appData.accounts = appData.accounts.filter((a) => a.id !== accountId);
    render();
    send("removeAccount", "DELETE", `/api/accounts/${encodeURIComponent(accountId)}`);
  }

  function updateSettings(partial) {
    Object.assign(appData.settings, partial);
    render();
    send("updateSettings", "PATCH", "/api/settings", partial);
  }

  function updateJiraOptions(partial) {
    Object.assign(appData.settings.jira, partial);
    render();
    send("updateJiraOptions", "PATCH", "/api/settings", { jira: partial });
  }

  return {
    init,
    subscribe, subscribeStatus, getSyncStatus,
    getUsers, getAccounts, getServers, getSettings, getSkippedTickets, getWaitingTickets,
    getJiraIssues, getLastJiraSyncAt,
    getUser, getAccount, getServer, getSignedInUserId,
    getRepositoriesForAccount, getDisplayStatus,
    getFilters, getFilteredServers, getSummary,
    setFilter, clearFilters,
    getServerTickets, getRepoClaims, getTicket,
    getRepoNote, setRepoNote,
    addClaim, forceFreeTicket, forceFreeServer,
    addServer, updateServer, removeServer, updateServerRepoUrl,
    matchUserIdsByLabels, matchRepositoriesToKeys, normalizeJiraNames,
    addUser, updateUser, removeUser,
    addAccount, updateAccount, removeAccount,
    updateSettings, updateJiraOptions
  };
})();
