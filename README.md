# Server Management

Tracks which QA/staging environments are free and which are held by a Jira
ticket, so nobody has to ask in chat before deploying.

Each **account** (client) owns a set of **environments** (`hotfix-1`,
`static-2`, …), and each environment has **repositories** — storefront,
backend, admin. A ticket claims one or more repositories of one environment,
so an environment can be *partly free*: backend taken, admin still bookable.

## Running it

Requires Node 18+ (uses built-in `fetch`) and a MySQL- or MariaDB-compatible
database. The board, credentials, sessions and Jira-derived data all live
there now — nothing is written to JSON files on disk.

```bash
npm install
cp config/.env.example config/.env      # fill in DATABASE_URL at minimum
npm run migrate                         # creates the schema
npm start                               # or: node server/index.js
# → http://localhost:6767 (set PORT to change it)
```

On a database with no sign-in accounts yet, the first boot creates one super
admin and prints its password once:

```
  ┌─ First run: a super admin account was created ─────────────
  │  username: admin
  │  password: XpcVNoqWQ14-lauB4aan
  │  You will be asked to set a new password on first sign-in.
```

Write it down — it is not shown again. In production, set `ADMIN_PASSWORD`
(and `ADMIN_USERNAME`) instead of relying on the generated one; outside
production `node server/index.js` refuses to start only if `DATABASE_URL` or
a usable `APP_SECRET_KEY` situation is missing (see `config/.env.example`
for what each variable does and what happens when it's left blank).

### Migrating from a previous checkout

If you have `shared-data/`, `shared-state.json`, or `config/auth.json` from
before this move — the board and its credentials as plain JSON files — bring
them in with:

```bash
node server/cli/import-legacy.js            # dry run: reports what it would do
node server/cli/import-legacy.js --apply    # writes it
```

It runs the same `migrateAppData()` upgrade path those files always went
through, so it does not matter how old the shape is. Existing passwords keep
working — the exact scrypt parameters they were hashed with are preserved
alongside them, and each one is quietly upgraded to the current parameters
the next time its owner signs in. Sessions are **not** carried over (the old
store kept tokens as plaintext; importing one would mean hashing an
already-leaked value), so everyone signs in again once. Once you've checked
the board, delete the old files — the import never does it for you.

## How the repo is laid out

```
server/
  index.js           the gate, the routing table, boot — wiring only
  config.js          every environment variable, resolved and validated once
  paths.js           static file roots, resolved from the repo root
  ip-allowlist.js     which addresses may reach any of it
  static.js          serves public/ and shared/ — and nothing else
  jira-client.js     talking to Jira: URLs, auth header, field-id cache

  db/
    client.js        the connection pool, query/transaction helpers
    migrate.js        applies server/db/migrations/*.sql, tracked + checksummed
    migrations/       numbered, immutable once applied
    columns.js         JSON/date/bool conversions every repository shares

  repositories/       the only layer allowed to contain SQL
  services/           business rules — no SQL, no req/res
  http/               cookies, CSRF, the request pipeline, the route table
  routes/             thin handlers: parse, call one service, shape the reply
  realtime/           the event bus and the SSE transport
  jobs/               health checks, Jira sync, expiry, housekeeping — on timers
  security/            password hashing (scrypt, versioned, async)
  cli/                admin.js (operator commands), import-legacy.js

shared/
  data.js            seed data, the role table, Jira status/matching rules
  rules.js           form validation — the same functions the server runs

public/              the app — the only thing served, with shared/
  index.html  js/**
```

The line worth knowing is still between `public/` and everything else. The
static handler can read `public/` and `shared/` only, so nothing else is
reachable over http — not the database credentials, not a session token, not
the server's own source.

## The board

Everything — the directory of people, accounts, environments, claims, notes,
settings, Jira-derived data, sessions, and the audit log — lives in the
database `DATABASE_URL` points at. `server/db/migrations/*.sql` describes the
schema; `npm run migrate` applies whatever is pending, and refuses to start
if a previously-applied migration file has since been edited (they're meant
to be immutable — add a new numbered file instead of changing one).

The board is pushed to every open tab over Server-Sent Events — not as the
whole board on every change, but as the one small event describing what
changed, so a note edit costs a few hundred bytes rather than the entire
board. `GET /api/state` still returns the whole thing in one request, for
the initial page load and for a tab reconnecting after a gap.

`localStorage` still caches the board so a server that drops mid-session
does not blank the page; that cache is a fallback for *display only* and no
part of the app depends on writing to it.

## Signing in

Hand out accounts under **Users**: a display name, a username, a password,
and one role. Every account created this way — including the seeded first
one — must set a new password on its first sign-in.

### People and logins are one list, kept in two tables

**Users** shows everybody on the board, with each person's login beside them
if they have one. Most will not: being assignable to a claim and being able
to sign in are different things, and most of a team only ever needs the
first. Directory people live separately from login accounts precisely so
that the directory — which is broadcast to every open tab — never carries a
password hash; a login optionally points at one directory person by id, and
reads that person's Jira **Ticket Assignee** labels through the link rather
than keeping its own copy. One person can hold at most one login.

| Role | Can |
| --- | --- |
| Super admin | Everything, plus creating credentials and handing out roles |
| Admin | Everything except managing who can sign in |
| Member | Claim and free environments, write notes |
| Viewer | Read the board, change nothing |

Sessions last a week, sliding after 12 hours of inactivity. Signing out,
changing a password, changing someone's role, or deactivating them ends
every session that person has immediately — not at their next reload.

Passwords are hashed with scrypt, asynchronously (a synchronous hash on the
request path would stall every other request on the process), and the
parameters used are stored with the hash so they can be raised later without
invalidating anything — an old hash is silently upgraded the next time its
owner signs in successfully. Every mutating request also carries a CSRF
token minted with the session; a request missing it, or arriving from
another origin, is refused before it reaches anything else.

Repeated failed sign-ins are throttled with a doubling backoff, tracked in
the database rather than in memory — a crash or restart does not reset it.
The curve tightens automatically while the IP allowlist below is left open,
since that is the only remaining gate.

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
  a deploy can't lock the whole team out of a running portal. The sign-in
  throttle above tightens automatically in this state.
- **Loopback is always allowed**, whatever the list says — otherwise the
  host can't reach its own portal. `ALLOW_LOOPBACK=false` turns that off if
  the machine has local users or SSH tunnels you don't trust.
- **Behind a proxy, set `TRUST_PROXY`.** Behind nginx, Cloudflare, ngrok or
  a PaaS router, the socket peer is the proxy and *every* request looks like
  one address — set `TRUST_PROXY` to the number of proxies in front of the
  server and the client is read from `X-Forwarded-For` instead. It is off by
  default on purpose: that header is client-writable, so trusting it with no
  proxy in front lets anyone claim any address. The same setting also
  decides whether `X-Forwarded-Proto` is trusted for deciding the session
  cookie's `Secure` flag (`COOKIE_SECURE=auto`, the default).

**It does not gate VS Code Live Share.** Live Share tunnels a guest's
traffic through the host machine, so every guest arrives as loopback and
the allowlist cannot tell them from you — and neither can the per-address
sign-in throttle. Who joins the session is what limits access there.

## Connecting Jira

Fill in your site, the account email, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) in
**Settings**, then turn on **Enable Jira**. The token is encrypted at rest
(AES-256-GCM under `APP_SECRET_KEY`) in the database, never in a plain file.

A deployment can instead supply `JIRA_BASE_URL` / `JIRA_EMAIL` /
`JIRA_API_TOKEN` as environment variables — Settings then shows the fields
read-only and refuses a write, since the connection isn't this deployment's
to change from the UI.

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

The sync itself is incremental: after the first full pass it only asks Jira
for what changed since the last poll (plus, always, anything currently
holding an environment — so a ticket that reaches `DONE`, which is both a
releasing status and one nobody wants pulled in bulk, is never missed). A
poll that finds nothing new writes nothing and sends every open tab a
sixty-byte heartbeat rather than the whole board; a full sweep every thirty
minutes reconciles anything an incremental pass could legitimately have
missed.

## Architecture

Layered, one direction of dependency:

```
routes/  →  services/  →  repositories/  →  db/
   │            │
   │            └──► realtime/bus  (emit what changed)
   └──► http/{cookies,csrf,pipeline}, realtime/sse (subscribe)

jobs/  →  services/        (never repositories/, never routes/)
```

**Repositories** are the only place SQL appears — no validation, no
permission checks, no events, just queries and row-to-object mapping.
**Services** hold every rule (validation, ripple effects, authorization
decisions, what to emit) and never see `req`/`res`. **Routes** are 5–15 lines
each: parse the request, call one service, shape the reply. **Jobs** call
services on a timer and never touch a repository or a route directly.

`shared/data.js` and `shared/rules.js` are the one pair of modules both the
browser and the server load — the server via `require()`, the browser as a
plain `<script>` — so seed data, the role table, Jira status matching, and
form validation are one implementation with two callers, not two
implementations that can quietly disagree.

### The realtime layer

`GET /api/events` opens a Server-Sent Events stream. Its first frame is the
whole board (`board.snapshot`); after that, each change is its own small
event — `claim.created`, `note.set`, `server-repo.health`, and so on — with a
monotone sequence number. A tab that notices a gap in that sequence, or
receives an event type it doesn't recognise, falls back to refetching the
whole board rather than risking a silent drift from the truth. Every open
stream re-checks both the IP allowlist and the session on every single frame
it sends, not just at connect time, so revoking someone's access or removing
their address takes effect on their very next event rather than at their
next reload.

### Things worth knowing before changing it

- **Occupancy is derived, never stored.** `State.getDisplayStatus()` on the
  client computes free/partial/inuse/issue from the live claim list. An
  offline repository outranks everything else.
- **Claims are sticky across status changes.** Only a *releasing* status
  frees a claim; every other status leaves it alone. That rule lives in
  `server/services/jira-sync.service.js` — the client only reads the result.
- **Roles are enforced twice, from one list.** `AUTH_ROLES` in
  `shared/data.js` is read by the browser (to hide what you can't use) and by
  the request pipeline (to refuse it), so the two cannot drift. Hiding is
  courtesy; the server is the boundary.
- **Validation is enforced twice, from one implementation.** `shared/rules.js`
  is called by `public/js/state.js` (so a form's error list is synchronous,
  with no round trip) and by the matching `server/services/*.js` function
  (the actual boundary). If a request that passed client-side validation is
  still rejected by the server — a genuine race with another tab, most
  likely — the client resyncs from the server's event stream rather than
  trusting its own optimistic guess.
- **Tailwind comes from a CDN.** The v4 browser build compiles in the page,
  including classes injected after load. That keeps the no-build-step
  property for the UI, but it is the one thing standing between the
  Content-Security-Policy this server sends and actually disallowing inline
  scripts and styles.
