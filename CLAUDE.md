# CLAUDE.md

Context for AI sessions in this repo. Read this first, then the doc it points you at.

## What this project is

**Server Management** — a board tracking which QA/staging environments are free and which are held by a
Jira ticket, so nobody has to ask in chat before deploying.

Accounts (clients) own environments; each environment has repository slots (`storefront`, `backend`,
`admin`); a Jira ticket claims one or more repos of one environment, so an environment can be *partly
free*.

## Current state — read this before assuming anything

There are **two architectures** in play, and mixing them up is the main hazard:

| | |
|---|---|
| **Running today** | Zero-dependency Node 24 + vanilla JS + JSON files on disk + SSE. `server/`, `public/`, `shared/`, `shared-data/`, `config/`. Fully working. |
| **Planned** | Next.js + Vercel + Neon Postgres + Pusher + Vercel Blob. **Documented in `docs/`. Not implemented. No code written yet.** |

If you are asked to build a feature, ask which architecture it targets. Adding to the old one is
usually wasted work — see `docs/04-MIGRATION-PLAN.md`.

## Documentation map

| Doc | Read it when |
|---|---|
| `docs/00-CONTEXT-CURRENT-SYSTEM.md` | You need to know how anything works **today** |
| `docs/01-TARGET-ARCHITECTURE.md` | Working on the migration or the new stack |
| `docs/02-DATA-MODEL.md` | Touching the schema or any query |
| `docs/03-REALTIME-SPEC.md` | Touching Pusher, chat, presence or events |
| `docs/04-MIGRATION-PLAN.md` | Deciding what to build next |
| `docs/05-DECISIONS.md` | Tempted to do something differently — check whether it was already decided and why |
| `docs/06-OPEN-QUESTIONS.md` | Blocked on a product decision |

## Running the current app

```bash
npm start          # node server/index.js → http://localhost:4000
```

Node 18+ (uses built-in `fetch`). No build step, no dependencies, no `node_modules`.
First run seeds a super admin and prints the credentials.

`npm test` is a stub (`exit 1`). **There are no tests.**

## Invariants — do not break these without a decision recorded in `docs/05-DECISIONS.md`

1. **Occupancy is derived, never stored.** `free` / `partial` / `inuse` / `issue` is computed from
   live claims plus repo health. An offline repo outranks everything else.
2. **Claims are sticky.** Only a *releasing* or terminal Jira status frees a claim. Every other status
   leaves it alone — `QA FAILED` is still being worked, so it keeps the environment.
3. **One capability list, enforced twice.** `AUTH_ROLES` is read by the browser to hide and by the
   server to refuse. Hiding is courtesy; **the server is the boundary.** Never add a UI-only check.
4. **Instant revocation.** Changing a password, a role, or an account's active flag ends every session
   that person holds, immediately. This is documented behaviour, not an implementation detail.
5. **Secrets never reach the client.** The Jira API token, password hashes and session tokens are never
   part of the board and never pushed over any realtime channel.
6. **Jira matching is exact.** Account Name + Branch + Repository, case-insensitive exact match, no
   fuzzy guessing. An unmatchable ticket surfaces on **Not tracked** with the reason and the fix rather
   than silently claiming the wrong box.
7. **Escape everything users type.** Notes today, chat messages tomorrow. Centralised in
   `Format.escapeHtml` / `H.esc`.

## Two identity spaces — the most common source of bugs

| | Auth account | Directory person |
|---|---|---|
| Where | `config/auth.json` | `shared-data/users.json` |
| Means | **can sign in** | **can be assigned a claim** |
| Coverage | a minority of the team | everyone on the board |

Linked optionally one-to-one via `account.directoryUserId`. **Most people on the board have no login.**
A login reads its Jira assignee labels *through* that link rather than storing its own copy.

Before writing anything that says "user", decide which of these two you mean.

## Known problems (do not rediscover these)

Full list in `docs/00-CONTEXT-CURRENT-SYSTEM.md`. The load-bearing ones:

- `POST /api/state` replaces the **whole board**, last-write-wins, no concurrency control. `setFilter`
  calls the same path, so typing in the search box POSTs the entire board.
- The SSE channel has **no addressing**, so it cannot carry anything private.
- No SSE heartbeat, no replay on reconnect, and an open stream is never re-authenticated.
- `config/auth.json` is read synchronously on every authenticated request and written non-atomically.
- No rate limiting except the login lockout. No CSRF tokens (`SameSite=Lax` carries it, so every
  state-changing route must stay a POST).
- `package-lock.json` is stale: it declares `@neondatabase/serverless` and the name `server-manager`,
  while `package.json` declares no dependencies and the name `server-management`.
- `README.md` links `DEPLOY.md`, which does not exist.

## Conventions in the current codebase

- Server: CommonJS, `require`. Client: IIFE modules on `window` globals, load order fixed in
  `public/index.html`.
- Strict UI layering: `tokens` → `model` → `html` → `page-*`. Each layer knows only the one below.
- A page is `{ label, render() }` returning a **string** and touching no DOM. Adding one = one file +
  one `NAV` entry in `shell.js`.
- **One** delegated click listener, in `actions.js`, dispatching on `data-action`.
- Semantic colour tokens only (`bg-surface`, `text-muted`). No literal colours, no `dark:` variants —
  dark mode is one set of CSS variable overrides.
- Comments in this codebase explain **why**, often at length. Match that when editing; it is the
  repo's main form of documentation.

## Working style

- Prefer reading the source over assuming. This codebase is unusually well commented and the comments
  are accurate.
- Do not add dependencies to the current app — zero dependencies is deliberate. The new stack changes
  this, but only within `docs/`-planned work.
- Don't touch `config/` or `shared-data/` — credentials and live state, both gitignored.
