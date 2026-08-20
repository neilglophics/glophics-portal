# 00 — Context: the current system (as-is)

> Snapshot of the system **as it exists today**, before the Next.js migration.
> Everything here was read from the source, not assumed. Line references are to the
> pre-migration code and will go stale once Phase 1 of [04-MIGRATION-PLAN.md](04-MIGRATION-PLAN.md) lands.

## What the product does

Tracks which QA/staging environments are free and which are held by a Jira ticket, so nobody has to
ask in chat before deploying.

- An **account** (client, e.g. "Sticker Market") owns a set of **environments** (`Server 01`, `hotfix-2`).
- Each environment carries one **repository slot per repo its account defines** — typically
  `storefront`, `backend`, `admin` — each with its own URL and its own health.
- A **ticket** claims one or more repositories of one environment. So an environment can be
  *partly free*: backend taken, admin still bookable.
- **Occupancy is derived, never stored.** `State.getDisplayStatus()` computes
  `free` / `partial` / `inuse` / `issue` from the live claim list. An offline repo outranks everything.
- **Claims are sticky across status changes.** Only a *releasing* status frees a claim; every other
  status leaves it alone (`QA FAILED` is still being worked, so it keeps the environment). That rule
  lives in `runJiraSync()` server-side; the client only reads the result.

## Stack as-is (all verified)

| | |
|---|---|
| Runtime | Node 24.14.0, CommonJS, **zero runtime dependencies** |
| Build | **None.** No bundler, no transpile, no `node_modules` present |
| Server | Raw `node:http` server, hand-rolled routing |
| Frontend | Vanilla JS IIFE modules on `window` globals, ordered `<script>` tags |
| CSS | Tailwind v4 **from CDN, compiled in the browser at runtime** |
| Routing (client) | Hash router (`#dashboard`, `#environments`, …) |
| Storage | Plain JSON files on disk, one per board section |
| Auth storage | `config/auth.json` — scrypt hashes **and live session tokens** |
| Realtime | Server-Sent Events, full-board push |
| Tests | **None.** `npm test` is `echo "Error: no test specified" && exit 1` |

Two inconsistencies found in the repo:

- **`package-lock.json` is stale.** It declares `@neondatabase/serverless ^1.1.0` and the package
  name `server-manager`, while `package.json` declares no dependencies and the name
  `server-management`. Someone already started down the Neon path — which is the stack now chosen.
- **`README.md` links `DEPLOY.md`, which does not exist** in the repo.

## Repository layout

```
server/            everything that runs on the server
  index.js         the gate, the routing table, boot — wiring only
  paths.js         every path, resolved from the repo root
  board.js         the board in memory, plus persist() and broadcast()
  state-store.js   the board on disk (shared-data/, one file per section)
  auth-store.js    credentials and sessions (config/auth.json)
  ip-allowlist.js  which addresses may reach any of it
  access.js        who is calling, and whether their role permits it
  static.js        serves public/ and shared/ — and nothing else
  jira-client.js   talking to Jira, and the API token that needs
  http.js          sendJson / readBody
  routes/          auth.js  state.js  jira.js
  jobs/            health.js  sync.js
shared/
  data.js          THE ONE MODULE BOTH SIDES RUN
public/            the app — the only thing served, with shared/
  index.html       shell markup + fixed script order
  js/
    storage.js     persistence: server + SSE, localStorage fallback
    state.js       the single source of truth; every read and write
    auth.js        who is signed in, and what they may do
    format.js      dates, durations, escaping
    ui/
      tokens.js    every colour, label and icon
      model.js     view-models derived from State
      html.js      presentational primitives (tables, chips, buttons…)
      router.js    hash routing + input-preserving re-render
      actions.js   ONE delegated listener, data-action dispatch
      modals.js    assign / confirm / note / credential dialogs
      login-screen.js, shell.js, env-detail.js, ticket-table.js, theme.js
      page-*.js    one file per page
    app.js         boot
config/            auth.json, jira-config.json, allowed-ips.json (+ examples)
shared-data/       the board, one file per section (gitignored)
```

## The security model — order is the whole point

From `server/index.js`, and the ordering is load-bearing:

1. **IP allowlist** (`server/index.js:114`) — runs **before routing, before sessions, before even the
   sign-in screen**. A non-allowlisted address gets a bare `403 Forbidden` for every path, so a
   stranger never learns there is a portal here. Supports plain IPs, CIDR, and the aliases `lan` /
   `loopback`; merges `ALLOWED_IPS` env with `config/allowed-ips.json`; hot-reloads within seconds.
   `TRUST_PROXY` is **off by default** on purpose, because `X-Forwarded-For` is client-writable.
2. **The public auth handshake** — the only part of the API a stranger reaches:
   `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
3. **Everything else** — `currentUser(req)` (`server/index.js:126`) or 401, then each route names the
   capability it needs via `allows(res, user, capability)`.

**Static serving is locked down by layout, not by extension.** `static.js` can read only `public/`
and `shared/`. Credentials, the Jira token and the whole board are simply not under a root it can
look at. The MIME extension allowlist (which deliberately has **no `.json` entry**) is the second
lock, not the only one.

### Sessions

- Cookie `sm_session`: `HttpOnly; SameSite=Lax; Path=/`, **deliberately not `Secure`** because the
  server speaks plain HTTP on a LAN.
- 7-day TTL. Tokens stored in `config/auth.json` **next to** the scrypt hashes.
- scrypt with a per-user random salt, compared with `crypto.timingSafeEqual`. No dependencies.
- Failed sign-ins: 8 per username then a 10-minute lockout, counted **in memory**.
- **Instant revocation is load-bearing.** Changing a password, changing a role, or deactivating an
  account calls `revokeSessionsFor()` and drops every session that user has. The README documents
  this as a feature: "an open tab loses the access it had rather than keeping it until reload."
  Any replacement auth design must preserve it.

### Roles and capabilities

`AUTH_ROLES` in `shared/data.js` is read by **both** sides — the browser to hide what you cannot use,
`server/access.js` to refuse it — so the two cannot drift. Hiding is courtesy; the server is the
boundary.

| Role | view | claim | configure | manage-users |
|---|:-:|:-:|:-:|:-:|
| `superadmin` | ✔ | ✔ | ✔ | ✔ |
| `admin` | ✔ | ✔ | ✔ | |
| `member` | ✔ | ✔ | | |
| `viewer` | ✔ | | | |

An unknown role grants nothing — a typo in a stored role fails closed.

## Two identity spaces (critical for chat)

This is the single most important thing to understand before designing chat.

| | Auth account | Board directory person |
|---|---|---|
| Lives in | `config/auth.json` | `shared-data/users.json` |
| Id shape | `crypto.randomUUID()` | slug, e.g. `"sem"`, `"jerome"` |
| Means | **can sign in** | **can be assigned a claim** |
| Carries | username, displayName, role, hash | name, job role, `jiraNames[]` |

They are linked **optionally and one-to-one** by `account.directoryUserId`. An account reads its
Jira assignee labels *through* that link rather than keeping its own copy, so a label is written once.

**Per the README, most people on the board have no login at all** — "being assignable to a claim and
being able to sign in are different things, and most of a team only ever needs the first." Some
accounts also point at nobody.

## Data layer as-is

`server/board.js` holds the entire board in memory as a **property** (`Board.state`), not an exported
binding, because `POST /api/state` replaces the whole object in one assignment and four other modules
must see the replacement.

`server/state-store.js` persists it to `shared-data/`, one file per section
(`users`, `accounts`, `servers`, `settings`, `notes`, `tickets`). This is careful work worth
respecting: atomic tmp-file + rename per section, skip-if-unchanged by byte comparison, coalescing of
overlapping saves, and a `quarantine()` path that moves an unreadable directory aside instead of
seeding over it and destroying every claim. Total current size ≈ 7 KB.

`JIRA_DERIVED_KEYS` (`jiraIssues`, `jiraSkipped`, `lastJiraSyncAt`) are **never persisted** — they are
three-quarters of the board by size, stale the moment the process stops, and refilled by the sync at
boot.

## The write path (the defining constraint of the old design)

```
UI action → State.<mutator>() → notify() → Storage.save(appData) → POST /api/state
                                                                    ↳ WHOLE BOARD
```

`handlePost` **replaces the entire board in one assignment**. Last-write-wins.
**No version, no ETag, no optimistic concurrency.** Two people editing at once means one silently
clobbers the other.

The server defends exactly two things:
- `JIRA_DERIVED_KEYS` are forced back from the server's own copy (the browser's is at best equal).
- A role without `configure` gets `users` / `accounts` / `servers` / `settings` restored from the
  server copy — the payload is **stripped, not rejected**, because their config copy may be a beat
  stale through no fault of theirs.

**`setFilter` also calls `notify()`.** Typing in the search box (200 ms debounce) POSTs the entire
board. This is a real pre-existing clobber hazard.

## Realtime as-is

- `GET /api/events` opens one long-lived SSE response per watching tab, registered into
  `Board.sseClients` (a `Set` of raw `res` objects).
- `Board.broadcast()` writes **one unnamed `data:` frame containing the ENTIRE board to EVERY
  connected client**. It re-checks the IP allowlist per client on the way out and drops any client
  whose address was removed from the list.
- Client side: `new EventSource("/api/events")`, `onmessage` replaces all of `appData`.
- **Absent:** named events, event ids, `Last-Event-ID` replay, heartbeat/keepalive, and any kind of
  per-user filtering or addressing.
- Broadcast triggers: `POST /api/state`; health job (30 s, only when something changed); expiry job
  (30 s); Jira sync (every 20 s, broadcasts on **every** pass when enabled).

Consequence that matters: **the current channel cannot carry a private message.** Addressing has to
be built before any DM exists, or every DM goes to every tab.

## Background jobs as-is

Started after `listen()` (so a failed bind doesn't leave timers running):

| Job | Interval | Notes |
|---|---|---|
| `health.runHealthChecks` | 30 s | `fetch` each repo URL, 5 s timeout. Any HTTP response counts as up; only a failed connection marks offline. No URL stays `unconfigured`. |
| `sync.runExpiryChecks` | 30 s | Only acts when `settings.onExpiry === "auto-release"` |
| `sync.runJiraSync` | 20 s tick | Internally throttled by `settings.jira.pollIntervalMinutes` |

**Health checks ping hostnames like `https://backend.srv-01.internal`.** These are private/LAN names.
This is the fact that breaks hardest under a serverless host — see
[06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q1.

## Jira integration as-is

- Config in `config/jira-config.json` (gitignored) or `JIRA_BASE_URL` / `JIRA_EMAIL` /
  `JIRA_API_TOKEN` env. Read fresh on every call, so hand-edits apply without a restart.
  **Never part of the board, so never broadcast.** The config route masks the token even from people
  allowed to change it.
- Matching: **Account Name + Branch + Repository**, all three required on the ticket,
  case-insensitive exact match only — no fuzzy guessing. Unmatchable tickets land on the
  **Not tracked** page with the reason and the fix.
- Custom field ids are discovered by name via `/rest/api/3/field` and cached for 10 minutes.
- Search uses `/rest/api/3/search/jql` with opaque `nextPageToken` paging (the old
  `/rest/api/3/search` was removed by Atlassian and answers 410). Window `updated >= -30d`,
  100/page, capped at 5 pages.
- The JQL deliberately adds `OR key IN (…held keys…)` so tickets already holding repos are always
  re-fetched by key — otherwise a ticket that reached `DONE` (both a releasing status and an ignored
  one) would hold its environment forever with no way for Jira to say otherwise.

## Full API surface as-is

| Route | Method | Capability |
|---|---|---|
| `/api/auth/login` | POST | **public** |
| `/api/auth/logout` | POST | **public** |
| `/api/auth/me` | GET | **public** |
| `/api/auth/password` | POST | any session |
| `/api/auth/users` | GET, POST | `manage-users` |
| `/api/auth/users/:id` | POST, DELETE | `manage-users` |
| `/api/auth/users/:id/password` | POST | `manage-users` |
| `/api/state` | GET | `view` |
| `/api/state` | POST | `claim` — whole-board replace |
| `/api/events` | GET | `view` — SSE |
| `/api/health/check-now` | POST | `view` |
| `/api/jira-config` | GET / POST | `view` / `configure` |
| `/api/jira-config/test` | POST | `configure` |
| `/api/jira/comment` | POST | `claim` |
| `/api/jira/sync-now` | POST | `view` |
| `/api/jira/:KEY-123` | GET | `view` |

## UI patterns worth carrying forward

These are good and should survive the rewrite in spirit, even where the mechanism changes:

- **Strict layering.** `tokens` (what colour is "partly free"?) → `model` (what does a row contain?) →
  `html` (what does a table look like?) → `page-*` (what goes on this page?). Each layer knows only
  the one below.
- **Semantic colour tokens, never literal ones.** Components ask for `bg-surface` / `text-muted`.
  Dark mode is one set of variable overrides — no `dark:` variant on any component.
- **One capability list, enforced twice.** Keep this. It is the reason UI and server cannot disagree.
- **`page-users.js` is the closest precedent for chat**: the one page whose data comes from a REST API
  *outside* the board. Module-local cache, a `mount()` hook that loads on first paint, a `reload()`
  that re-renders when data lands. Chat should follow this shape, not the board's.
- **Escaping is centralised** in `Format.escapeHtml` / `H.esc` and used consistently. Chat is the
  first feature where users type text other users read, so this discipline becomes security-critical.

## Known problems in the current system

Carried into [05-DECISIONS.md](05-DECISIONS.md) and [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md).

1. Whole-board `POST /api/state` is last-write-wins with no concurrency control; `setFilter` makes it
   fire on every search keystroke.
2. The SSE channel has no addressing, so it cannot carry anything private.
3. No heartbeat on the SSE stream; an idle stream dies at ~60 s behind any proxy.
4. No replay on reconnect — events during a disconnect are lost.
5. An already-open SSE stream is never re-authenticated, so a revoked session keeps receiving pushes
   until the stream happens to drop.
6. `config/auth.json` is read synchronously (`readFileSync` + `JSON.parse`) on **every** authenticated
   request.
7. `config/auth.json` is written **non-atomically** (plain `writeFileSync`), unlike the board store
   which uses tmp+rename. Concurrent session writes can corrupt it, and a corrupt file fails closed
   and re-seeds a super admin.
8. No rate limiting anywhere except the login lockout.
9. No CSRF tokens. `SameSite=Lax` covers cross-site POST today, which is why every state-changing
   route must stay a POST.
10. Every State change repaints the whole page via `innerHTML`, plus a forced repaint every 30 s.
11. Tailwind compiles in the browser from a CDN — already flagged in the README as not production.
12. Zero tests.
