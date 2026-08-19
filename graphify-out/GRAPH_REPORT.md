# Graph Report - server-management  (2026-08-19)

## Corpus Check
- Corpus is ~44,430 words - fits in a single context window. You may not need a graph.

## Summary
- 407 nodes · 725 edges · 29 communities (18 shown, 11 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 99 edges (avg confidence: 0.59)
- Token cost: 69,960 input · 0 output

## Community Hubs (Navigation)
- Server HTTP & Jira Client
- Server Wiring & Routes
- Credential & Session Store
- Jira Sync & Shared Data Model
- Portal Design Rationale
- Section State Store
- IP Allowlist & Modals
- Architecture & Domain Concepts
- Package Manifest
- Settings Page
- Users Page
- App Bootstrap & Routing
- Assignees Page
- Health Page
- Tickets Page
- In-Use Page
- Environments Page
- Not Tracked Page
- Formatting Helpers
- Local Storage Cache
- UI Action Dispatch
- Environment Detail View
- HTML Template Helpers
- Login Screen
- Client Data Model
- Portal Shell Chrome
- Ticket Table Component
- Design Tokens

## God Nodes (most connected - your core abstractions)
1. `sendJson()` - 22 edges
2. `load()` - 14 edges
3. `runJiraSync()` - 12 edges
4. `save()` - 11 edges
5. `updateUser()` - 11 edges
6. `readBody()` - 10 edges
7. `loadJiraConfig()` - 10 edges
8. `handleJiraLookup()` - 10 edges
9. `createUser()` - 9 edges
10. `normalizeBaseUrl()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Pre-Paint Theme Bootstrap Script` --semantically_similar_to--> `localStorage Board Cache`  [INFERRED] [semantically similar]
  public/index.html → README.md
- `Semantic Colour Palette (@theme tokens)` --semantically_similar_to--> `UI Layering: tokens to model to html to pages`  [INFERRED] [semantically similar]
  public/index.html → README.md
- `State` --indirect_call--> `updateUser()`  [INFERRED]
  public/js/state.js → server/auth-store.js
- `Modals` --indirect_call--> `changeOwnPassword()`  [INFERRED]
  public/js/ui/modals.js → server/auth-store.js
- `Auth` --indirect_call--> `changeOwnPassword()`  [INFERRED]
  public/js/auth.js → server/auth-store.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Sign-in and access control flow** — readme_ip_allowlist, readme_credential_store, readme_auth_roles, readme_session_invalidation, readme_person_login_link, public_index_auth_root [INFERRED 0.85]
- **Jira ticket claim and release lifecycle** — readme_jira_integration, readme_ticket_matching_rule, readme_status_rules, readme_sticky_claims, readme_derived_occupancy, readme_not_tracked_page [INFERRED 0.85]
- **No-build-step design commitment** — readme_no_build_step, readme_tailwind_cdn, public_index_script_order, public_index_semantic_palette, readme_shared_data_module [INFERRED 0.75]

## Communities (29 total, 11 thin omitted)

### Community 0 - "Server HTTP & Jira Client"
Cohesion: 0.08
Nodes (59): allows(), Auth, currentUser(), denyCapability(), parseCookies(), { sendJson }, sessionCookie(), readBody() (+51 more)

### Community 1 - "Server Wiring & Routes"
Cohesion: 0.06
Nodes (34): Board, IpAllowlist, StateStore, Auth, authRoutes, Board, { currentUser }, fs (+26 more)

### Community 2 - "Credential & Session Store"
Cohesion: 0.14
Nodes (36): Auth, AUTH_FILE, { AUTH_ROLES, roleCan, isValidRole, userJiraNames, matchUserIdsByLabels }, changeOwnPassword(), { CONFIG_DIR }, createUser(), crypto, deleteUser() (+28 more)

### Community 3 - "Jira Sync & Shared Data Model"
Cohesion: 0.10
Nodes (30): State, Board, buildSyncJql(), extractTicketFields(), fetchJiraSearchIssues(), jqlText(), {
  matchRepositoriesToKeys, matchUserIdsByLabels, findServerForTicket,
  statusIn, statusFrees, statusIsTerminal
}, {
  normalizeBaseUrl, jiraIssuePath, jiraBrowseUrl,
  loadJiraConfig, jiraConfigured, jiraAuthHeader,
  AUTOFILL_FIELD_NAMES, loadFieldIdMap, pickFieldValue, firstOf
} (+22 more)

### Community 4 - "Portal Design Rationale"
Cohesion: 0.07
Nodes (31): #auth-root sign-in mount, #modal-host, Both Roots Hidden Until Session Known, Scroll Containment (overflow-hidden body), #shell board mount, sync-jira toolbar action, The Board, board.js as the Only Shared Mutable Module (+23 more)

### Community 5 - "Section State Store"
Cohesion: 0.13
Nodes (26): archiveLegacyFile(), { buildDefaultAppData, migrateAppData, withoutJiraDerived, JIRA_DERIVED_KEYS }, ensureDir(), firstFreePath(), fs, hydrate(), lastWritten, LEGACY_FILE (+18 more)

### Community 6 - "IP Allowlist & Modals"
Cohesion: 0.11
Nodes (25): Modals, ALIASES, allows(), allowsIp(), blockedSeen, clientIp(), config, { CONFIG_DIR } (+17 more)

### Community 7 - "Architecture & Domain Concepts"
Cohesion: 0.09
Nodes (26): #account-menu (Shell.renderAccountMenu), Dark Mode via html.dark Variable Overrides, Glophics Portal Shell (index.html), Script Load Order (data layer then UI layer), Semantic Colour Palette (@theme tokens), Sidebar Nav Groups (overview / activity / accounts / settings), Pre-Paint Theme Bootstrap Script, Account (client) (+18 more)

### Community 8 - "Package Manifest"
Cohesion: 0.11
Nodes (17): author, bugs, url, description, homepage, keywords, license, main (+9 more)

### Community 9 - "Settings Page"
Cohesion: 0.16
Nodes (9): bookingCard(), directories(), directoryRow(), directoryRows(), fetchNote(), jiraCard(), render(), SettingsUi (+1 more)

### Community 10 - "Users Page"
Cohesion: 0.25
Nodes (12): actionsCell(), coverageNotice(), jiraCell(), lastSeenCell(), mount(), personCell(), reload(), render() (+4 more)

### Community 11 - "App Bootstrap & Routing"
Cohesion: 0.31
Nodes (6): bindSearch(), checkSessionOnDrop(), init(), start(), Router, Theme

### Community 12 - "Assignees Page"
Cohesion: 0.48
Nodes (5): emptyMessage(), linkNotice(), render(), subtitle(), ticketRows()

### Community 13 - "Health Page"
Cohesion: 0.52
Nodes (6): envRow(), expandableIds(), render(), repoBlock(), rows(), strip()

### Community 14 - "Tickets Page"
Cohesion: 0.53
Nodes (4): emptyMessage(), render(), subtitle(), ticketRows()

### Community 15 - "In-Use Page"
Cohesion: 0.70
Nodes (4): envRow(), expandableIds(), render(), rows()

### Community 17 - "Not Tracked Page"
Cohesion: 1.00
Nodes (3): classify(), render(), row()

## Knowledge Gaps
- **110 isolated node(s):** `name`, `version`, `description`, `main`, `test` (+105 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `State` connect `Jira Sync & Shared Data Model` to `Credential & Session Store`, `App Bootstrap & Routing`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `init()` connect `App Bootstrap & Routing` to `Jira Sync & Shared Data Model`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `matchUserIdsByLabels()` connect `Jira Sync & Shared Data Model` to `Server HTTP & Jira Client`, `Credential & Session Store`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `updateUser()` (e.g. with `Auth` and `State`) actually correct?**
  _`updateUser()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _110 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Server HTTP & Jira Client` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `Server Wiring & Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.057692307692307696 - nodes in this community are weakly interconnected._