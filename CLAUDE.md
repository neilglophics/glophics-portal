# CLAUDE.md

Context for AI sessions in this repo. Read this first, then the doc it points you at.

## What this project is

**Server Management** — a board tracking which QA/staging environments are free and which are held by a
Jira ticket, so nobody has to ask in chat before deploying.

Accounts (clients) own environments; each environment has repository slots (`storefront`, `backend`,
`admin`); a Jira ticket claims one or more repos of one environment, so an environment can be *partly
free*.

## Current state — read this before assuming anything

There are **two codebases in this repo**, and mixing them up is the main hazard.

| | Where | State |
|---|---|---|
| **New — build here** | `app/`, `lib/`, `components/`, `middleware.ts`, `scripts/` | Next.js 15 + TypeScript + Neon Postgres. Board, auth, Jira and cron are ported and building. |
| **Legacy — do not extend** | `server/`, `public/`, `shared/`, `shared-data/`, `config/` | The original zero-dependency Node app. Still runnable with `npm run legacy`. Kept only as a reference and a data source until cutover. |

**Default to the new codebase.** The legacy tree is deleted at Phase 13 of
`docs/04-MIGRATION-PLAN.md`; anything added to it is thrown away. Read the old files freely — they are
the best documentation of intended behaviour — but write in `app/` and `lib/`.

### What is done, and what is not

| Phase | |
|---|---|
| 1–6 | ✅ Scaffold, schema, import script, auth + gate, board read/write, Jira sync + cron |
| 7 | ⬜ Pusher realtime. **Not started.** No live updates yet — a change needs a refresh in other tabs. |
| 8–12 | ⬜ Chat, presence, attachments, notifications |
| 13 | ⬜ Cutover and deleting the legacy tree |

Two things are genuinely missing rather than merely unbuilt:

- **Nothing writes repository health.** A serverless function cannot reach `*.internal`, so every
  repo reads "Never checked". The UI says so honestly instead of showing a false `offline`, which
  would outrank claim state and paint the whole board red. Blocked on
  `docs/06-OPEN-QUESTIONS.md` **Q1**.
- **No realtime.** Mutations call `revalidatePath`, which refreshes the acting tab only.

## Running the new app

```bash
npm run dev
```

Needs a Neon branch. Copy `.env.example` to `.env.local`, then:

```bash
npm run db:migrate      # apply lib/db/migrations/*.sql
npm run db:import       # load shared-data/ + config/auth.json into Postgres
npm test                # 29 tests, node:test via tsx
npm run typecheck
```

`db:import` refuses rather than guesses — duplicate Jira labels and claims naming missing
environments are reported for a human. Re-run with `--truncate` after fixing them.

### Signing in

Imported accounts keep their **original** passwords: scrypt parameters are unchanged, so hashes
carried over from `config/auth.json` still verify.

**`ADMIN_PASSWORD` only seeds a first account when `auth_users` is empty.** Once any account exists it
is ignored silently — it is not a way to reset a password, deliberately, because an env var that could
overwrite a live credential would be a backdoor. Use the CLI instead:

```bash
npm run auth:list                                    # accounts, roles, lockout state
npm run auth:set-password -- <username> <password>   # min 8 chars
```

That drops the account's sessions **and** clears its failed-attempt counter — without the second part
you can set a fresh password and still be locked out for ten minutes, which reads as the new password
not working.

Two traps worth knowing: `.env.example` is a committed template and is **never read** (real values go
in `.env.local` or `.env`), and `db:import --truncate` clears `auth_sessions`, so browsers keep a
cookie that no longer resolves.

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

## Running the legacy app (reference only)

```bash
npm run legacy     # node server/index.js → http://localhost:4000
```

It reads `config/` and `shared-data/` directly, so running it will not disturb Postgres.

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
| Table | `auth_users` (was `config/auth.json`) | `directory_users` (was `shared-data/users.json`) |
| Id | `uuid` | slug — `"sem"`, `"jerome"` |
| Means | **can sign in** | **can be assigned a claim** |
| Coverage | a minority of the team | everyone on the board |

Linked optionally one-to-one via `account.directoryUserId`. **Most people on the board have no login.**
A login reads its Jira assignee labels *through* that link rather than storing its own copy.

Before writing anything that says "user", decide which of these two you mean.

## Legacy problems the migration already fixed

Do not "fix" these again; they are gone in `app/` + `lib/`.

- Whole-board `POST /api/state`, last-write-wins. Replaced by granular endpoints in transactions.
- `config/auth.json` read synchronously per request and written non-atomically. Now indexed queries.
- Live session tokens stored in plaintext. Now SHA-256 hashes in `auth_sessions`.
- In-memory login lockout. Now `auth_login_attempts`.
- Tailwind compiled in the browser from a CDN. Now a build step.
- Stale `package-lock.json`, and `npm test` as a stub. Both fixed.

Still true, and still worth knowing:

- **No CSRF tokens.** `SameSite=Lax` carries it, so **every state-changing route must stay a non-GET
  method**. A mutation on a GET silently loses the protection.
- **No rate limiting** except the login lockout. Chat will need it (`docs/03-REALTIME-SPEC.md` §10).
- `README.md` still links `DEPLOY.md`, which does not exist.

## Conventions

**New codebase.** TypeScript, App Router, Server Components by default — `"use client"` only where
there is real interaction. Reads go through `lib/db/queries/*`; those modules are the only place
snake_case appears. Mutations go through granular route handlers, each calling
`requireUser(capability)` first and a `revalidate*` helper last. Semantic colour tokens only
(`bg-surface`, `text-muted`) — no literal colours and no `dark:` variants, because dark mode is one
set of CSS variable overrides in `app/globals.css`.

**Both.** Comments explain **why**, often at length. That is this repo's main form of documentation —
match it. When porting, carry the original's reasoning across rather than just its behaviour.

## Working style

- Prefer reading the source over assuming. The legacy code is unusually well commented and the
  comments are accurate; it is the best spec for what a ported feature should do.
- Don't touch `config/` or `shared-data/` — credentials and legacy state, both gitignored. They are
  the import script's input.
- Check `docs/06-OPEN-QUESTIONS.md` before building anything that depends on a blocked decision.
