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

  function getSignedInUserId() {
    const authUser = typeof Auth !== "undefined" ? Auth.user() : null;
    if (!authUser) return null;
    const values = [authUser.id, authUser.username, authUser.displayName]
      .filter(Boolean).map((value) => String(value).trim().toLowerCase());
    const user = appData.users.find((candidate) =>
      [candidate.id, candidate.name].some((value) => values.includes(String(value).trim().toLowerCase()))
    );
    return user ? user.id : null;
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

  // Validated on the same rules as updateServer, so the add form and the
  // edit form reject exactly the same input.
  function addServer({ name, accountId, repoUrls }) {
    const nextName = (name || "").trim();
    const account = getAccount(accountId);

    const errors = [];
    if (!nextName) errors.push("Environment name is required.");
    if (!account) errors.push("Pick an account for this environment.");
    if (account && appData.servers.some((s) => s.accountId === account.id && s.name.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`${account.displayName} already has an environment called "${nextName}".`);
    }
    if (errors.length) return { ok: false, errors };

    const repos = {};
    getRepositoriesForAccount(account.id).forEach((repoName) => {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      repos[repoName] = { url, health: url ? "checking" : "unconfigured" };
    });
    appData.servers.push({ id: uid("server"), name: nextName, accountId: account.id, repos });
    notify();
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
    notify();
  }

  // An environment's name is the "Branch" Jira matches on, and its account
  // decides which repo slots it carries — so an edit ripples the same way
  // an account edit does: claims recorded under the old name/account are
  // rewritten, and repos the new account doesn't have take their urls,
  // notes and claims with them.
  function updateServer(serverId, { name, accountId, repoUrls }) {
    const server = getServer(serverId);
    if (!server) return { ok: false, errors: ["Environment not found."] };

    const nextName = (name || "").trim();
    const nextAccountId = accountId || server.accountId;
    const account = getAccount(nextAccountId);

    const errors = [];
    if (!nextName) errors.push("Environment name is required.");
    if (!account) errors.push("Pick an account for this environment.");
    if (account && appData.servers.some((s) => s.id !== serverId && s.accountId === nextAccountId && s.name.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`${account.displayName} already has an environment called "${nextName}".`);
    }
    if (errors.length) return { ok: false, errors };

    const repoNames = account.repositories;
    const removedRepos = Object.keys(server.repos).filter((r) => !repoNames.includes(r));

    server.name = nextName;
    server.accountId = nextAccountId;

    repoNames.forEach((repoName) => {
      const url = ((repoUrls && repoUrls[repoName]) || "").trim();
      // An untouched url keeps the health server.js last measured for it —
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

    notify();
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
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

  // Same rules as updateUser below — a new display name is what the next
  // sync matches Jira's assignee labels against, so it has to be unique.
  function addUser({ name, role }) {
    const nextName = (name || "").trim();
    const nextRole = (role || "").trim();

    const errors = [];
    if (!nextName) errors.push("Display name is required.");
    if (!nextRole) errors.push("Role is required.");
    if (appData.users.some((u) => u.name.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`Another user is already called "${nextName}".`);
    }
    if (errors.length) return { ok: false, errors };

    appData.users.push({ id: uid("user"), name: nextName, role: nextRole });
    notify();
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  // A user's display name is what Jira's "Ticket Assignee" labels are
  // matched against (data.js matchUserIdsByLabels), so a rename changes who
  // the next sync resolves a ticket to. Claims reference users by id, so
  // the ones already on the board follow the rename on their own.
  function updateUser(userId, { name, role }) {
    const user = getUser(userId);
    if (!user) return { ok: false, errors: ["User not found."] };

    const nextName = (name || "").trim();
    const nextRole = (role || "").trim();

    const errors = [];
    if (!nextName) errors.push("Display name is required.");
    if (!nextRole) errors.push("Role is required.");
    if (appData.users.some((u) => u.id !== userId && u.name.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`Another user is already called "${nextName}".`);
    }
    if (errors.length) return { ok: false, errors };

    user.name = nextName;
    user.role = nextRole;
    notify();
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
  }

  function removeUser(userId) {
    appData.users = appData.users.filter((u) => u.id !== userId);
    notify();
  }

  // The id is a slug of the display name unless one is passed explicitly,
  // so callers only have to collect the name people actually type.
  function addAccount({ id, displayName, repositories }) {
    const nextName = (displayName || "").trim();
    const nextId = (id || nextName).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const nextRepos = [...new Set((repositories || []).map((r) => r.trim()).filter(Boolean))];

    const errors = [];
    if (!nextName) errors.push("Display name is required.");
    // The id is derived, so a blank one only ever means the name had no
    // letters or digits to slug — say that instead of naming a hidden field.
    if (nextName && !nextId) errors.push("Display name needs at least one letter or number.");
    if (!nextRepos.length) errors.push("At least one repository is required.");
    // A duplicate name almost always slugs to a duplicate id too — report
    // the one the person actually typed, not both.
    if (nextName && appData.accounts.some((a) => a.displayName.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`Another account is already called "${nextName}".`);
    } else if (nextId && appData.accounts.some((a) => a.id === nextId)) {
      errors.push(`Account id "${nextId}" is already taken.`);
    }
    if (errors.length) return { ok: false, errors };

    appData.accounts.push({ id: nextId, displayName: nextName, repositories: nextRepos });
    notify();
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

    const nextId = (id || accountId).trim().toLowerCase().replace(/\s+/g, "-");
    const nextName = (displayName || "").trim();
    const nextRepos = [...new Set((repositories || []).map((r) => r.trim()).filter(Boolean))];

    const errors = [];
    if (!nextId) errors.push("Account id is required.");
    if (!nextName) errors.push("Display name is required.");
    if (!nextRepos.length) errors.push("At least one repository is required.");
    if (nextId !== accountId && appData.accounts.some((a) => a.id === nextId)) {
      errors.push(`Account id "${nextId}" is already taken.`);
    }
    if (appData.accounts.some((a) => a.id !== accountId && a.displayName.trim().toLowerCase() === nextName.toLowerCase())) {
      errors.push(`Another account is already called "${nextName}".`);
    }
    if (errors.length) return { ok: false, errors };

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

    notify();
    // A renamed account may match Jira tickets it didn't before — same
    // reasoning as addServer(): sync now instead of at the next poll tick.
    if (Storage.nudgeJiraSync) Storage.nudgeJiraSync();
    return { ok: true };
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
    getUser, getAccount, getServer, getSignedInUserId,
    getRepositoriesForAccount, getDisplayStatus,
    getFilters, getFilteredServers, getSummary,
    setFilter, clearFilters,
    getServerTickets, getRepoClaims, getTicket,
    getRepoNote, setRepoNote,
    addClaim, forceFreeTicket, forceFreeServer,
    addServer, updateServer, removeServer, updateServerRepoUrl,
    matchUserIdsByLabels, matchRepositoriesToKeys,
    addUser, updateUser, removeUser,
    addAccount, updateAccount, removeAccount,
    updateSettings, updateJiraOptions
  };
})();
