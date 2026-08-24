# Glophics

Tracks which QA/staging environments are free and which are held by a Jira
ticket, so nobody has to ask in chat before deploying.

Each **account** (client) owns a set of **environments** (`hotfix-1`,
`static-2`, …), and each environment has **repositories** — storefront,
backend, admin. A ticket claims one or more repositories of one environment,
so an environment can be *partly free*: backend taken, admin still bookable.

## Running it

Requires Node 18+ (uses built-in `fetch`). No build step, no dependencies.

```bash
npm start          # or: node server/index.js
# → http://localhost:4000
```

## How the repo is laid out

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
  data.js          the one module both sides run
public/            the app — the only thing served, with shared/
  index.html  js/**
config/            auth.json, jira-config.json, allowed-ips.json (+ examples)
shared-data/       the board, one file per section
```

The line worth knowing is between `public/` and everything else. The static
handler can read `public/` and `shared/`, so nothing else is reachable over
http at all — not `config/auth.json`'s password hashes and live session
tokens, not the board, not the server's own source. That used to rest on a
list of allowed file extensions that had to keep `.json` out forever, in a
directory that kept gaining files; now it rests on where the files are, and
the extension allowlist is the second lock rather than the only one.

## The board on disk

State lives in `shared-data/` — one file per section, so
the file you open is the one you meant and a save rewrites only what moved:

```
shared-data/
  users.json      the people a claim can be assigned to
  accounts.json   clients, and the repositories each one has
  servers.json    environments and their repo URLs + health
  tickets.json    the live claims
  notes.json      free-text notes per environment
  settings.json   Jira options, booking defaults, expiry rules
```

An older `shared-state.json` is split into these on the next start and kept
as `shared-state.json.migrated` — nothing is deleted. The board is pushed to
every open tab over Server-Sent Events, so a booking appears live for
everyone pointed at the same server. The server is now required: sign-in and every
data route go through it, so opening `public/index.html` as a file only ever
reaches the sign-in screen. (`localStorage` still caches the board so a
server that drops mid-session does not blank the page.)

For deploying, see [DEPLOY.md](DEPLOY.md). Short version: it needs a host
that runs a persistent process (Render, Railway, Fly, a VPS), not a
serverless one.

## Signing in

Everything behind the sign-in screen needs an account. The first time you
run `npm start` it creates one super admin and prints the password:

```
  ┌─ First run: a super admin account was created ─────────
  │  username: admin
  │  password: XpcVNoqWQ14-
```

That password is generated once and only the hash is kept, so save it then
— or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` before the first run and pick
it yourself. Sign in, then hand out accounts under **Users**: a display
name, a username, a password, and one role.

### People and logins are one list

**Users** shows everybody on the board, with each person's login beside them
if they have one. Most will not: being assignable to a claim and being able
to sign in are different things, and most of a team only ever needs the
first.

A login points at one person by id, and reads that person's Jira **Ticket
Assignee** labels through the link rather than keeping its own copy. So a
label is written once, in one place — fix a typo in the directory and what
**My tickets** shows is fixed with it. One person can hold at most one
login; the reverse would show two people each other's tickets.

Accounts written before the link existed are matched to their person on the
next start, using the same rule the ticket sync uses. Any that match nobody
— or match two people — are named on the console and left for a super admin
to point at the right person by hand; their old labels are kept, not
discarded, so there is something to go on.

| Role | Can |
| --- | --- |
| Super admin | Everything, plus creating credentials and handing out roles |
| Admin | Everything except managing who can sign in |
| Member | Claim and free environments, write notes |
| Viewer | Read the board, change nothing |

Sessions are a week long. Signing out, changing a password, changing
someone's role, or deactivating them ends every session that person has —
an open tab loses the access it had rather than keeping it until reload.

Credentials live in `config/auth.json` (gitignored, scrypt hashes, never
part of the shared state and never pushed over SSE — an account's record
there is a username, a role and the id of the person it points at, nothing
about them). An `auth.json`, `jira-config.json` or `allowed-ips.json` still
sitting in the repo root is moved into `config/` on the next start. The
cookie is `HttpOnly` and `SameSite=Lax`, and deliberately not `Secure`,
since this server speaks plain http on a LAN — add that flag if you put it
behind TLS.

## Restricting it to your own IP addresses

Sign-in decides *who* gets in; the allowlist decides *from where*. Name any
address and every request from anywhere else — the sign-in screen and the
static files included — is a bare `403 Forbidden`, so a stranger never gets
as far as a password prompt.

Either source works, and the two are merged:

```bash
ALLOWED_IPS="203.0.113.7, 198.51.100.0/24" npm start
```

```bash
cp config/allowed-ips.example.json config/allowed-ips.json   # gitignored
```

An entry is a plain IPv4/IPv6 address, a CIDR block, or one of the aliases
`lan` (the private ranges) and `loopback`. Find the address to put in it
from the network you want to allow — `curl ifconfig.me`, or any "what is my
IP" page. If your ISP hands out a dynamic address, allow the whole block
your office sits in (`198.51.100.0/24`) or put the portal behind a VPN and
allow the VPN's exit address instead.

Editing `config/allowed-ips.json` takes effect within a couple of seconds, no
restart — a typo that locks everyone out is undone by fixing the file.

Three things worth knowing:

- **An empty list means "not configured", not "nobody".** With nothing set
  the gate stays open and startup prints a warning, so a missing env var on
  a deploy can't lock the whole team out of a running portal.
- **Loopback is always allowed**, whatever the list says — otherwise the
  host can't reach its own portal. `ALLOW_LOOPBACK=false` turns that off if
  the machine has local users or SSH tunnels you don't trust.
- **Behind a proxy, set `TRUST_PROXY`.** Behind nginx, Cloudflare, ngrok or
  a PaaS router, the socket peer is the proxy and *every* request looks like
  one address — set `TRUST_PROXY` to the number of proxies in front of the
  server and the client is read from `X-Forwarded-For` instead. It is off by
  default on purpose: that header is client-writable, so trusting it with no
  proxy in front lets anyone claim any address.

**It does not gate VS Code Live Share.** Live Share tunnels a guest's
traffic through the host machine, so every guest arrives as loopback and
the allowlist cannot tell them from you. Who joins the session is what
limits access there — the allowlist covers direct network access, i.e. a
deployment or a port opened on the LAN.

## Connecting Jira

```bash
cp config/jira-config.example.json config/jira-config.json
```

Fill in your site, the account email, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens),
then turn on **Enable Jira** in Settings. `config/jira-config.json` is gitignored;
a deployment supplies `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`
instead, and Settings then shows the fields read-only.

Tickets are matched to an environment by **Account Name + Branch +
Repository**, all three of which must be filled in on the ticket. Anything
that can't be matched appears on the **Not tracked** page with the reason and
the fix, so a mis-filled ticket is visible rather than silently missing.

### How a ticket takes and releases a server

Configured under Settings → Status rules:

- **Occupies a server** — reaching one of these statuses claims the ticket's
  repositories (default: `QA TESTING (DEV)`, `QA TESTING (STG)`).
- **Frees the server** — reaching one of these releases them (default:
  `FINAL CHECKING`, `DONE`).
- Any *other* status leaves an existing claim untouched. `QA FAILED` is still
  being worked on, so it keeps the environment.

## Architecture

Two layers, one direction of dependency: **the UI reads the data layer; the
data layer knows nothing about the UI.**

```
shared/
  data.js           seed data, migrations, matching, the role list —
                    the one module both sides run

public/             the browser half
  index.html        shell markup + script order
  js/
    storage.js      persistence: server + SSE, localStorage fallback
    state.js        the single source of truth; every read and write
    auth.js         who is signed in, and what they may do
    format.js       dates, durations, escaping
    ui/
      tokens.js     every colour, label and icon
      model.js      view-models derived from State
      html.js       presentational primitives (tables, chips, buttons…)
      router.js     hash routing + input-preserving re-render
      actions.js    one delegated listener, `data-action` dispatch
      modals.js     assign / confirm / note / credential dialogs
      login-screen.js  the sign-in gate, shown before the shell exists
      shell.js      sidebar, account list, sync indicator, account menu
      page-*.js     one file per page
    app.js          boot: the sign-in gate, then State changes → render

server/             the server half
  index.js          the gate, the routing table, boot — wiring only
  paths.js          every path, resolved from the repo root
  board.js          the board in memory, plus persist() and broadcast()
  state-store.js    the board on disk: shared-data/, one file per section
  auth-store.js     credentials and sessions (config/auth.json)
  ip-allowlist.js   which addresses may reach the server at all
  access.js         who is calling, and whether their role permits it
  static.js         serves public/ and shared/, and nothing else
  jira-client.js    talking to Jira, and the API token that needs
  http.js           sendJson / readBody
  routes/
    auth.js         sign in/out, me, and managing who may sign in
    state.js        read/replace the board, and the live SSE stream
    jira.js         connection settings, ticket lookup, comment
  jobs/
    health.js       is each repository up?
    sync.js         the bulk Jira sync, and time-based expiry
```

**Data layer.** `public/js/state.js` is the only thing that touches app data.
Components never call `Storage` and never mutate `appData`; they call
`State.*` and subscribe to `State.subscribe()`. `shared/data.js` runs on both
sides — the server `require`s it, the browser loads it as `/shared/data.js` —
so the two apply identical seed and migration rules to the same shape. It is
the reason a board converted by one is a board the other recognises.

**Server layer.** `server/index.js` holds no logic of its own: it is the IP
gate, the routing table, and the boot-time migrations. Anything it dispatches
to lives in its own file, and the only shared mutable thing is `board.js` —
which exists because POST /api/state replaces the entire board in one
assignment, and four other files have to see that replacement.

**UI layer.** Each layer only knows the one below it:

| File | Answers |
| --- | --- |
| `tokens.js` | What colour is "partly free"? |
| `model.js` | What does an environment row contain? |
| `html.js` | What does a table look like? |
| `page-*.js` | What goes on this page? |

A page is `{ label, render() }` that registers itself with `Router`. It
returns a string and touches no DOM. Adding a page means creating one file
and adding one entry to `NAV` in `shell.js`.

**Events.** There is exactly one click listener, in `actions.js`. Markup
declares intent (`data-action="force-free-server"`) and a handler registers
against that name. Nothing re-binds after a render, and a re-render can't
leave a dead listener behind.

**Rendering.** Any State change repaints the whole active page. That keeps
the code simple and means an update pushed from another viewer shows up
immediately. `Router.render()` preserves scroll position and in-progress
field values across the repaint, so a background update never eats what
someone is typing.

### Things worth knowing before changing it

- **Occupancy is derived, never stored.** `State.getDisplayStatus()` computes
  free/partial/inuse/issue from the live claim list. An offline repository
  outranks everything else.
- **Claims are sticky across status changes.** Only a *releasing* status
  frees a claim; every other status leaves it alone. That rule lives in
  `runJiraSync()` in `server/jobs/sync.js` — the client only reads the result.
- **Roles are enforced twice, from one list.** `AUTH_ROLES` in `shared/data.js`
  is read by the browser (to hide what you can't use) and by
  `server/access.js` (to refuse it), so the two cannot drift. Hiding is courtesy; the server is the
  boundary. A member's state write is accepted but stripped back to
  tickets and notes rather than rejected — their copy of the config can be
  a beat stale through no fault of theirs.
- **Tailwind comes from a CDN.** The v4 browser build compiles in the page,
  including classes injected after load. That keeps the no-build-step
  property, but it is not a production setup — see the notes in
  [DEPLOY.md](DEPLOY.md) before shipping it publicly.
