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
 * start/end a jira-sourced claim is server.js's runJiraSync() job; this
 * file only reads/writes the resulting list.
 */

const State = (() => {
  let appData = null;
  let syncStatus = "offline";

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

  function notify() {
    Storage.save(appData);
    listeners.forEach((fn) => fn());
  }

  // Applies an update pushed by another viewer — already persisted on the
  // server, so this only updates local state and re-renders (no save-back).
  function applyRemoteUpdate(data) {
    appData = data;
    listeners.forEach((fn) => fn());
  }

  function setSyncStatus(status) {
    syncStatus = status;
    statusListeners.forEach((fn) => fn(status));
  }

  function getSyncStatus() { return syncStatus; }

  async function init() {
    appData = await Storage.load();
    if (migrateAppData(appData)) Storage.save(appData);
    Storage.subscribeRemote(applyRemoteUpdate, setSyncStatus);
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
  // Tickets Jira matched to this environment that are not at an occupying
  // status — they're on the branch but hold no repo.
  function getWaitingTickets(serverId) {
    return (appData.jiraWaiting || []).filter((w) => w.serverId === serverId);
  }
  function getLastJiraSyncAt() { return appData.lastJiraSyncAt || null; }

  function getUser(id) { return appData.users.find((u) => u.id === id) || null; }
  function getAccount(id) { return appData.accounts.find((a) => a.id === id) || null; }
  function getServer(id) { return appData.servers.find((s) => s.id === id) || null; }

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
    notify();
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
      if (filters.userId !== "all" && !claims.some((t) => t.userIds.includes(filters.userId))) return false;
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

  function setFilter(key, value) {
    filters[key] = value;
    notify();
  }

  function clearFilters() {
    filters.status = "all";
    filters.userId = "all";
    filters.accountId = "all";
    filters.search = "";
    notify();
  }

  // ---------- validation ----------

  const JIRA_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

  function validateClaim({ repos, userIds, jiraTicket, startTime, endTime }) {
    const errors = [];
    if (!repos || !repos.length) errors.push("Select at least one repo to claim.");
    if (!userIds || !userIds.length) errors.push("At least one user is required.");
    const requireTicket = appData.settings.jira.requireTicket;
    if (jiraTicket || requireTicket) {
      if (!jiraTicket || !JIRA_PATTERN.test(jiraTicket.trim())) {
        errors.push("Jira ticket must look like PROJ-1234.");
      }
    }
    if (!startTime || !endTime) {
      errors.push("Start and end time are required.");
    } else if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
      errors.push("End time must be after start time.");
    }
    return errors;
  }

  // ---------- claim actions ----------

  // Creates a claim on specific repos of a specific environment. If a real
  // ticket key is given it's tagged source:"jira" so runJiraSync() takes it
  // over from here (refreshing its status/summary, auto-freeing it once
  // the ticket reaches a releasing status) — otherwise it's a plain manual
  // claim that only a person (via Force free) can end.
  function addClaim(serverId, payload) {
    const server = getServer(serverId);
    if (!server) return { ok: false, errors: ["Server not found."] };

    const repoKeys = Object.keys(server.repos);
    const repos = (payload.repos || []).filter((r) => repoKeys.includes(r));
    const jiraTicket = payload.jiraTicket ? payload.jiraTicket.trim().toUpperCase() : null;

    const errors = validateClaim({ ...payload, repos, jiraTicket });
    if (errors.length) return { ok: false, errors };

    const account = getAccount(server.accountId);
    const ticket = {
      id: jiraTicket || uid("manual"),
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
    notify();
    return { ok: true, ticket };
  }

  function forceFreeTicket(ticketId) {
    appData.tickets = appData.tickets.filter((t) => t.id !== ticketId);
    notify();
  }

  function forceFreeServer(serverId) {
    appData.tickets = appData.tickets.filter((t) => t.serverId !== serverId);
    notify();
  }

  // ---------- config CRUD (settings) ----------

  function addServer({ name, accountId, repoUrls }) {
    const repoNames = getRepositoriesForAccount(accountId);
    const repos = {};
    repoNames.forEach((repoName) => {
      const url = (repoUrls && repoUrls[repoName]) || "";
      repos[repoName] = { url, health: url ? "checking" : "unconfigured" };
    });
    appData.servers.push({ id: uid("server"), name, accountId, repos });
    notify();
    // A ticket for this exact account+environment may already be sitting in
    // Jira — nudge an immediate sync so it populates right away instead of
    // waiting for the next poll tick.
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
  }

  function removeServer(serverId) {
    appData.servers = appData.servers.filter((s) => s.id !== serverId);
    appData.tickets = appData.tickets.filter((t) => t.serverId !== serverId);
    Object.keys(appData.notes).forEach((k) => { if (k.startsWith(`${serverId}::`)) delete appData.notes[k]; });
    notify();
  }

  function updateServerRepoUrl(serverId, repoName, url) {
    const server = getServer(serverId);
    if (!server || !server.repos[repoName]) return;
    server.repos[repoName].url = url;
    server.repos[repoName].health = "checking";
    notify();
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

  function addUser({ name, role }) {
    appData.users.push({ id: uid("user"), name, role });
    notify();
  }

  function removeUser(userId) {
    appData.users = appData.users.filter((u) => u.id !== userId);
    notify();
  }

  function addAccount({ id, displayName, repositories }) {
    appData.accounts.push({ id, displayName, repositories });
    notify();
  }

  function removeAccount(accountId) {
    appData.accounts = appData.accounts.filter((a) => a.id !== accountId);
    notify();
  }

  function updateSettings(partial) {
    Object.assign(appData.settings, partial);
    notify();
  }

  function updateJiraOptions(partial) {
    Object.assign(appData.settings.jira, partial);
    notify();
  }

  return {
    init,
    subscribe, subscribeStatus, getSyncStatus,
    getUsers, getAccounts, getServers, getSettings, getSkippedTickets, getWaitingTickets, getLastJiraSyncAt,
    getUser, getAccount, getServer,
    getRepositoriesForAccount, getDisplayStatus,
    getFilters, getFilteredServers, getSummary,
    setFilter, clearFilters,
    getServerTickets, getRepoClaims, getTicket,
    getRepoNote, setRepoNote,
    addClaim, forceFreeTicket, forceFreeServer,
    addServer, removeServer, updateServerRepoUrl,
    matchUserIdsByLabels, matchRepositoriesToKeys,
    addUser, removeUser,
    addAccount, removeAccount,
    updateSettings, updateJiraOptions
  };
})();
