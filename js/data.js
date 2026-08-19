/**
 * Default seed data. Only used the first time the app runs (no localStorage yet).
 * After that, storage.js owns the live copy and this file is not read again.
 */

// `name` is what the board shows; `jiraNames` is what Jira actually writes
// in a ticket's "Ticket Assignee" field. They start out the same, and a
// person who appears under more than one label collects the rest there.
const DEFAULT_USERS = [
  { id: "sem", name: "[BE]_Sem", role: "Backend", jiraNames: ["[BE]_Sem"] },
  { id: "jerome", name: "[QA]_Jerome", role: "QA", jiraNames: ["[QA]_Jerome"] },
  { id: "neil", name: "[FE]_Neil", role: "Frontend", jiraNames: ["[FE]_Neil"] }
];

const DEFAULT_ACCOUNTS = [
  { id: "singaprinting", displayName: "Singapore Printing", repositories: ["storefront", "backend", "admin"] },
  { id: "allstickerprinting", displayName: "All Sticker Printing", repositories: ["storefront", "backend", "admin"] },
  { id: "ozstickerprinting", displayName: "Oz Sticker Printing", repositories: ["storefront", "backend", "admin"] },
  { id: "stickerdot", displayName: "Sticker Dot", repositories: ["storefront", "backend", "admin"] },
  { id: "stickermarket", displayName: "Sticker Market", repositories: ["storefront", "backend", "admin"] },
  { id: "stickercanada", displayName: "Sticker Canada", repositories: ["storefront", "backend", "admin"] },
  { id: "stickerjapan", displayName: "Sticker Japan", repositories: ["storefront", "backend", "admin"] },
  { id: "musticker", displayName: "Musticker", repositories: ["storefront", "backend", "admin"] }
];

/**
 * A server is an "environment" (e.g. one account's "hotfix-2" box) that
 * hosts ALL of that account's repos at once, each independently tracked:
 *   repos: { storefront: { url, health }, backend: { url, health }, admin: { url, health } }
 * accountId is permanent. `health` per repo is live-updated by server.js
 * pinging that repo's own url — any repo offline makes the environment show
 * "Needs attention" regardless of whether it's booked.
 *
 * A server no longer carries its own booking fields. Occupancy is derived:
 * appData.tickets holds every *active claim* — a ticket (real Jira, or a
 * manual "Assign") currently occupying one or more specific repos on one
 * specific server. Several tickets can claim different repos of the same
 * server at once (a "partly free" environment), and a repo can be claimed
 * by more than one ticket at a time ("Shared"). See js/state.js for how
 * claims are derived/synced and js/ui.js for how they render.
 */
function buildRepos(urls) {
  const repos = {};
  Object.keys(urls).forEach((repoName) => {
    const url = urls[repoName] || "";
    repos[repoName] = { url, health: url ? "checking" : "unconfigured" };
  });
  return repos;
}

function buildDefaultServers() {
  return [
    {
      id: "server-01", name: "Server 01", accountId: "ozstickerprinting",
      repos: buildRepos({ storefront: "https://storefront.srv-01.internal", backend: "https://backend.srv-01.internal", admin: "https://admin.srv-01.internal" })
    },
    {
      id: "server-02", name: "Server 02", accountId: "singaprinting",
      repos: buildRepos({ storefront: "https://storefront.srv-02.internal", backend: "https://backend.srv-02.internal", admin: "https://admin.srv-02.internal" })
    },
    {
      id: "server-03", name: "Server 03", accountId: "stickermarket",
      repos: buildRepos({ storefront: "https://storefront.srv-03.internal", backend: "https://backend.srv-03.internal", admin: "https://admin.srv-03.internal" })
    },
    {
      id: "server-04", name: "Server 04", accountId: "stickerdot",
      repos: buildRepos({ storefront: "https://storefront.srv-04.internal", backend: "https://backend.srv-04.internal", admin: "https://admin.srv-04.internal" })
    },
    {
      id: "server-05", name: "Server 05", accountId: "stickercanada",
      repos: buildRepos({ storefront: "https://storefront.srv-05.internal", backend: "https://backend.srv-05.internal", admin: "https://admin.srv-05.internal" })
    },
    {
      id: "server-06", name: "Server 06", accountId: "allstickerprinting",
      repos: buildRepos({ storefront: "https://storefront.srv-06.internal", backend: "https://backend.srv-06.internal", admin: "https://admin.srv-06.internal" })
    },
    {
      id: "server-07", name: "Server 07", accountId: "stickerjapan",
      repos: buildRepos({ storefront: "https://storefront.srv-07.internal", backend: "https://backend.srv-07.internal", admin: "https://admin.srv-07.internal" })
    },
    {
      id: "server-08", name: "Server 08", accountId: "musticker",
      repos: buildRepos({ storefront: "https://storefront.srv-08.internal", backend: "https://backend.srv-08.internal", admin: "https://admin.srv-08.internal" })
    }
  ];
}

// A demo claim on Server 02/03/06 so the seeded board isn't all-empty —
// mirrors the old seed bookings, now expressed as manual claims.
function buildDefaultTickets() {
  const now = new Date();
  const today = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString(); };
  return [
    {
      id: "manual-seed-1", source: "manual", serverId: "server-02",
      accountName: "Singapore Printing", branch: "Server 02",
      repos: ["storefront", "backend", "admin"], userIds: ["sem"], rawAssignees: [],
      status: "Manual", summary: null, note: "Checkout regression pass.",
      startTime: today(9, 0), endTime: today(17, 0), claimedAt: today(9, 0), lastSyncedAt: null
    },
    {
      id: "manual-seed-2", source: "manual", serverId: "server-03",
      accountName: "Sticker Market", branch: "Server 03",
      repos: ["storefront", "backend", "admin"], userIds: ["jerome"], rawAssignees: [],
      status: "Manual", summary: null, note: null,
      startTime: today(8, 30), endTime: today(12, 30), claimedAt: today(8, 30), lastSyncedAt: null
    },
    {
      id: "manual-seed-3", source: "manual", serverId: "server-06",
      accountName: "All Sticker Printing", branch: "Server 06",
      repos: ["storefront", "backend", "admin"], userIds: ["neil"], rawAssignees: [],
      status: "Manual", summary: null, note: "PDP layout QA.",
      startTime: today(10, 15), endTime: today(18, 30), claimedAt: today(10, 15), lastSyncedAt: null
    }
  ];
}

// The full real workflow vocabulary (from the team's Jira sub-task
// workflow) — shown in Settings so "Occupies"/"Frees" can be picked from
// the actual statuses in use, not guessed. A status not in either list
// leaves an already-active claim untouched ("sticky") — see
// State.runTicketSync's comment for why that matters.
// Statuses that end a ticket's life. Nothing here is waiting on an
// environment, whatever the configured releasing statuses happen to be.
const JIRA_TERMINAL_STATUSES = ["DONE", "CLOSED", "CANCELLED"];

const JIRA_STATUS_VOCABULARY = [
  "OPEN", "IN PROGRESS", "TO REVIEW", "QA FAILED", "CANCELLED", "ON HOLD",
  "QA TESTING (DEV)", "QA TESTING (STG)", "LIVE DEPLOYMENT", "QA TESTING (LIVE)",
  "FINAL CHECKING", "DONE", "CLOSED"
];

const DEFAULT_SETTINGS = {
  defaultBookingHours: 4,
  onExpiry: "remind",
  // Claiming is per-repo, but most bookings take the whole environment.
  // On, the Assign modal starts with every free repo ticked.
  assignWholeEnv: true,
  jira: {
    enabled: false,
    requireTicket: true,
    pullTicketInfo: true,
    commentOnRelease: false,
    // A ticket claims its matched repos the moment it reaches one of these
    // statuses, and releases them the moment it reaches one of the
    // releasingStatuses. Any other status leaves an existing claim as-is —
    // e.g. QA FAILED doesn't free the environment, it's still being worked.
    occupyingStatuses: ["QA TESTING (DEV)", "QA TESTING (STG)"],
    releasingStatuses: ["FINAL CHECKING", "DONE"],
    pollIntervalMinutes: 1,
    autoSync: true
  }
};

function buildDefaultAppData() {
  return {
    users: DEFAULT_USERS,
    accounts: DEFAULT_ACCOUNTS,
    servers: buildDefaultServers(),
    tickets: buildDefaultTickets(),
    notes: {},
    jiraSkipped: [],
    jiraWaiting: [],
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  };
}

/**
 * Upgrades appData saved by older versions of this app in place. Returns
 * true if anything changed (caller should persist). Shared between the
 * browser (storage.js) and server.js so both apply the same rules to the
 * same on-disk/localStorage shape.
 */
function migrateAppData(appData) {
  let changed = false;
  const fallbackAccountId = appData.accounts[0] ? appData.accounts[0].id : null;

  if (!Array.isArray(appData.tickets)) appData.tickets = [];
  if (!appData.notes) appData.notes = {};
  if (!Array.isArray(appData.jiraSkipped)) appData.jiraSkipped = [];
  if (!Array.isArray(appData.jiraWaiting)) appData.jiraWaiting = [];

  // A user's display name used to double as their Jira assignee label.
  // Seeding jiraNames from it keeps every existing directory matching
  // exactly what it matched before, and gives people somewhere to add the
  // other labels Jira knows them by.
  (appData.users || []).forEach((user) => {
    if (Array.isArray(user.jiraNames)) return;
    user.jiraNames = user.name ? [user.name] : [];
    changed = true;
  });

  appData.servers.forEach((server) => {
    if (server.url === undefined && server.hostname !== undefined) {
      server.url = server.hostname;
      delete server.hostname;
      changed = true;
    }
    if (!server.accountId && fallbackAccountId) {
      server.accountId = fallbackAccountId;
      changed = true;
    }
    // A server used to have exactly one repo (url/repository/health at the
    // top level). It now hosts every one of its account's repos at once —
    // fold the one repo this record already had into `repos` and leave the
    // others unconfigured (empty url, "unconfigured" health) rather than
    // guessing which other record might really be "the same environment".
    if (!server.repos) {
      const account = appData.accounts.find((a) => a.id === server.accountId);
      const repoNames = (account && account.repositories.length) ? account.repositories : ["storefront", "backend", "admin"];
      const repos = {};
      repoNames.forEach((repoName) => {
        if (repoName === server.repository && server.url) {
          repos[repoName] = { url: server.url, health: server.health && server.health !== "checking" ? server.health : "checking" };
        } else {
          repos[repoName] = { url: "", health: "unconfigured" };
        }
      });
      server.repos = repos;
      delete server.url;
      delete server.repository;
      delete server.health;
      changed = true;
    }

    // Pre-v3 shape kept one booking directly on the server (status/userIds/
    // jiraTicket/note/startTime/endTime/activeRepos) plus a FIFO queue.
    // Convert whatever's actively booked into a claim in appData.tickets —
    // a real jiraTicket becomes a "jira"-sourced claim (the next sync
    // reconciles its live status), a ticket-less booking becomes "manual".
    // Queued entries had nowhere to wait anymore (concurrent claims replace
    // the queue), so they become active claims immediately too.
    if (server.status !== undefined) {
      const account = appData.accounts.find((a) => a.id === server.accountId);
      const toTicket = (src, idPrefix) => ({
        id: src.jiraTicket ? src.jiraTicket.toUpperCase() : `${idPrefix}-${server.id}-${Math.random().toString(36).slice(2, 8)}`,
        source: src.jiraTicket ? "jira" : "manual",
        serverId: server.id,
        accountName: account ? account.displayName : "",
        branch: server.name,
        repos: (src.activeRepos && src.activeRepos.length) ? src.activeRepos : Object.keys(server.repos),
        userIds: src.userIds || [],
        rawAssignees: [],
        status: src.jiraTicket ? "Migrated — pending sync" : "Manual",
        summary: null,
        note: src.note || null,
        startTime: src.startTime || null,
        endTime: src.endTime || null,
        claimedAt: src.startTime || new Date().toISOString(),
        lastSyncedAt: null
      });

      if (server.status === "inuse") {
        appData.tickets.push(toTicket(server, "migrated"));
      }
      if (Array.isArray(server.queue)) {
        server.queue.forEach((q) => appData.tickets.push(toTicket(q, "migrated-queue")));
      }

      delete server.status;
      delete server.userIds;
      delete server.jiraTicket;
      delete server.note;
      delete server.startTime;
      delete server.endTime;
      delete server.queue;
      delete server.activeRepos;
      changed = true;
    }
  });

  // Pre-v3 history log (one row per assign/release) has no equivalent in
  // the claims model — drop it rather than carry dead weight forward.
  if (appData.assignments !== undefined) {
    delete appData.assignments;
    changed = true;
  }

  if (!appData.settings) {
    appData.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    changed = true;
  } else {
    if (!appData.settings.jira) {
      appData.settings.jira = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.jira));
      changed = true;
    } else {
      const jira = appData.settings.jira;
      if (!Array.isArray(jira.occupyingStatuses)) {
        jira.occupyingStatuses = [...DEFAULT_SETTINGS.jira.occupyingStatuses];
        changed = true;
      }
      if (!Array.isArray(jira.releasingStatuses)) {
        // Carry the old single-list setting forward if it was customized.
        jira.releasingStatuses = (Array.isArray(jira.releaseOnStatuses) && jira.releaseOnStatuses.length)
          ? jira.releaseOnStatuses.map((s) => s.toUpperCase())
          : [...DEFAULT_SETTINGS.jira.releasingStatuses];
        changed = true;
      }
      if ("releaseOnStatuses" in jira) { delete jira.releaseOnStatuses; changed = true; }
      if ("autoReleaseOnClose" in jira) { delete jira.autoReleaseOnClose; changed = true; }
      if (jira.pollIntervalMinutes === undefined) { jira.pollIntervalMinutes = DEFAULT_SETTINGS.jira.pollIntervalMinutes; changed = true; }
      if (jira.autoSync === undefined) { jira.autoSync = DEFAULT_SETTINGS.jira.autoSync; changed = true; }
    }
    if (appData.settings.defaultBookingHours === undefined) {
      appData.settings.defaultBookingHours = DEFAULT_SETTINGS.defaultBookingHours;
      changed = true;
    }
    if (!appData.settings.onExpiry) {
      appData.settings.onExpiry = DEFAULT_SETTINGS.onExpiry;
      changed = true;
    }
    if (appData.settings.assignWholeEnv === undefined) {
      appData.settings.assignWholeEnv = DEFAULT_SETTINGS.assignWholeEnv;
      changed = true;
    }
  }

  return changed;
}

// ---------- Jira label matching (shared by state.js and server.js) ----------
// The "Repository" ticket field is free-text labels, not our repo keys —
// translate the known synonyms (confirmed: API=backend; Admin/Frontend are
// the literal/obvious reading of admin panel vs. customer storefront).
const REPO_LABEL_SYNONYMS = {
  api: "backend", backend: "backend",
  admin: "admin",
  frontend: "storefront", storefront: "storefront"
};

function matchRepositoriesToKeys(labels, validKeys) {
  const matched = [];
  const unmatched = [];
  (labels || []).forEach((label) => {
    const key = REPO_LABEL_SYNONYMS[(label || "").trim().toLowerCase()];
    if (key && validKeys.includes(key)) matched.push(key);
    else unmatched.push(label);
  });
  return { matched, unmatched };
}

// The labels Jira may write for one person. Empty falls back to the
// display name, so a directory that predates the field still matches.
function userJiraNames(user) {
  const names = (Array.isArray(user.jiraNames) ? user.jiraNames : [])
    .map((n) => (n || "").trim()).filter(Boolean);
  return names.length ? names : [(user.name || "").trim()].filter(Boolean);
}

// Matches a Jira ticket's "Ticket Assignee" label values against
// configured users by their Jira names (exact, then case-insensitive).
// One person can carry several labels — the same tester is "[QA]_Jerome"
// on one board and "[QA]_Jerome_C" on another — so a label that matched
// nobody is reported rather than guessed at.
function matchUserIdsByLabels(labels, users) {
  const matched = [];
  const unmatched = [];
  const hits = (user, test) => userJiraNames(user).some(test);
  (labels || []).forEach((label) => {
    const raw = (label || "").trim();
    const lower = raw.toLowerCase();
    const user = users.find((u) => hits(u, (n) => n === raw))
      || users.find((u) => hits(u, (n) => n.toLowerCase() === lower));
    if (!user) unmatched.push(label);
    else if (!matched.includes(user.id)) matched.push(user.id);
  });
  return { matched, unmatched };
}

// A ticket names its account (Account Name) and environment (Branch, which
// is expected to equal the environment's own name) — no fuzzy guessing
// beyond case-insensitive exact match, so a mismatch is reported rather
// than silently claiming the wrong box.
function findServerForTicket(ticketData, accounts, servers) {
  const accountName = (ticketData.accountName || "").trim().toLowerCase();
  const branch = (ticketData.branch || "").trim().toLowerCase();
  if (!accountName) return { error: "Account Name is empty." };
  if (!branch) return { error: "Branch is empty." };

  const account = accounts.find((a) => a.displayName.trim().toLowerCase() === accountName);
  if (!account) return { error: `No account named "${ticketData.accountName}" is configured.` };

  const server = servers.find((s) => s.accountId === account.id && s.name.trim().toLowerCase() === branch);
  if (!server) return { error: `No environment named "${ticketData.branch}" under ${account.displayName}.` };

  return { server };
}

// ---------- Access roles (shared by the browser and server.js) ----------
// A role is a named set of capabilities. Both sides read this same list, so
// what the UI hides and what the server refuses can never drift apart —
// the UI hides on `roleCan()`, and every API route checks the same call.
//
//   view          read the board
//   claim         assign, force free, edit notes  (writes to tickets/notes)
//   configure     settings, Jira credentials, the directories
//   manage-users  create sign-in credentials and hand out roles
//
// Ordered most-privileged first; the pickers render them in this order.
const AUTH_ROLES = [
  {
    id: "superadmin", label: "Super admin",
    description: "Full access, plus creating sign-in credentials and roles.",
    capabilities: ["view", "claim", "configure", "manage-users"]
  },
  {
    id: "admin", label: "Admin",
    description: "Everything except managing who can sign in.",
    capabilities: ["view", "claim", "configure"]
  },
  {
    id: "member", label: "Member",
    description: "Can claim and free environments, and write notes.",
    capabilities: ["view", "claim"]
  },
  {
    id: "viewer", label: "Viewer",
    description: "Read-only. Sees the board, changes nothing.",
    capabilities: ["view"]
  }
];

function getRole(roleId) {
  return AUTH_ROLES.find((r) => r.id === roleId) || null;
}

// An unknown role grants nothing rather than defaulting to something
// permissive — a typo in a stored role must fail closed.
function roleCan(roleId, capability) {
  const role = getRole(roleId);
  return !!role && role.capabilities.includes(capability);
}

function roleLabel(roleId) {
  const role = getRole(roleId);
  return role ? role.label : roleId || "Unknown";
}

function isValidRole(roleId) {
  return !!getRole(roleId);
}

// Lets server.js reuse the same seed/migration/matching logic via require() — no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildDefaultAppData, migrateAppData, JIRA_STATUS_VOCABULARY, JIRA_TERMINAL_STATUSES,
    matchRepositoriesToKeys, matchUserIdsByLabels, userJiraNames, findServerForTicket,
    AUTH_ROLES, getRole, roleCan, roleLabel, isValidRole
  };
}
