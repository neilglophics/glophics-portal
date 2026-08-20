# 01 — Target architecture

The chosen stack. This document is the destination; [04-MIGRATION-PLAN.md](04-MIGRATION-PLAN.md) is
the route there.

| Concern | Technology |
|---|---|
| App framework | **Next.js (App Router) + TypeScript** |
| Hosting | **Vercel** |
| Database | **Neon Postgres** |
| Realtime | **Pusher Channels** (`pusher` server SDK + `pusher-js` client) |
| Media / attachments | **Vercel Blob** |
| Scheduled work | **Vercel Cron** |
| Styling | Tailwind, compiled at build time (replaces the runtime CDN build) |

> **Version note.** Exact platform limits (Vercel Cron frequency per plan, Pusher connection and
> message quotas, Blob access modes, function body size) change over time. Every limit quoted below is
> marked *verify*. Confirm against current docs before relying on one for a design decision.

---

## 1. The shape of the change

The current app is a **single persistent Node process that owns all state in memory** and pushes it to
every tab over its own SSE connection. Vercel gives you **short-lived, stateless function invocations
with no shared memory and no long-lived connections**.

So three things move out of the process:

```
BEFORE (one process owns everything)        AFTER (process owns nothing)

  Board.state ── in memory                   Neon Postgres ── the only source of truth
  Board.sseClients ── in memory               Pusher ── holds the connections, fans out
  setInterval jobs ── in process              Vercel Cron ── invokes a route on a schedule
  config/auth.json ── on local disk           Neon Postgres ── users + sessions
  shared-data/*.json ── on local disk         Neon Postgres ── the board
  attachments (n/a today)                     Vercel Blob
```

**This is why Pusher is the right call for this stack.** SSE from a serverless function is a dead end:
the function would have to stay alive holding the response open, which is exactly what the platform
does not do. A hosted realtime service inverts it — the server *publishes* and returns immediately.
Recorded as [ADR-002](05-DECISIONS.md#adr-002).

---

## 2. Runtime map

| Piece | Runtime | Why |
|---|---|---|
| `middleware.ts` | **Edge** | Runs on every request including static assets. Must be cheap. |
| Auth route handlers | **Node** (`export const runtime = "nodejs"`) | `node:crypto` `scrypt` is not available on Edge |
| All other route handlers | Node (default) | Simplicity; one runtime for all business logic |
| Server Components | Node | Read from Neon directly, no API hop |
| Cron targets | Node | Long-ish work, Jira `fetch`, Node APIs |

**Do not put authoritative session validation in middleware.** Middleware is Edge, cannot run `scrypt`,
and should not be the security boundary for role checks. Middleware does the two cheap things:

1. The IP allowlist (see §5).
2. A **presence** check on the session cookie — no cookie means redirect to `/login`, nothing more.

The authoritative check is a `requireUser(capability)` helper called by **every** route handler and
every protected Server Component. That preserves the current model's most important property: the
server is the boundary, and the UI only hides.

---

## 3. Directory structure (target)

```
app/
  (auth)/login/page.tsx            the sign-in gate
  (app)/                           everything behind the gate
    layout.tsx                     shell: sidebar, topbar, PusherProvider
    dashboard/page.tsx
    environments/page.tsx
    environments/[serverId]/page.tsx
    health/page.tsx
    tickets/page.tsx
    my-tickets/page.tsx
    in-use/page.tsx
    not-tracked/page.tsx
    chat/page.tsx                  NEW
    chat/[conversationId]/page.tsx NEW
    users/page.tsx
    settings/page.tsx
  api/
    auth/login|logout|me|password/route.ts
    auth/users/[[...id]]/route.ts
    board/route.ts                 GET the board (replaces GET /api/state)
    claims/route.ts                POST create a claim   (granular — see §6)
    claims/[id]/route.ts           DELETE force-free
    notes/route.ts
    servers/[[...id]]/route.ts
    accounts/[[...id]]/route.ts
    directory/[[...id]]/route.ts   board people (NOT logins)
    settings/route.ts
    jira/config|test|sync-now|comment/route.ts
    jira/[key]/route.ts
    health/check-now/route.ts
    chat/conversations/route.ts            NEW
    chat/conversations/[id]/messages/route.ts  NEW
    chat/conversations/[id]/read/route.ts      NEW
    chat/typing/route.ts                       NEW
    chat/attachments/upload-url/route.ts       NEW  (Blob client-upload token)
    pusher/auth/route.ts                       NEW  (private/presence channel auth)
    cron/health|jira-sync|expiry|retention/route.ts
lib/
  db/
    client.ts        Neon client factory (HTTP vs pooled — see §4)
    schema.sql       canonical DDL
    migrations/      NNNN-name.sql, forward-only
    queries/         one module per aggregate: board, claims, chat, auth
  auth/
    session.ts       createSession / resolveSession / revokeSessionsFor
    password.ts      scrypt hash + timingSafeEqual
    require.ts       requireUser(capability) — THE server-side boundary
  realtime/
    server.ts        Pusher server client + typed publish()
    channels.ts      channel name builders + parsers (shared client/server)
    events.ts        the typed event union (shared client/server)
  blob/
    attachments.ts   upload token issuing + validation
  jira/
    client.ts, sync.ts, matching.ts
  shared/
    roles.ts         AUTH_ROLES — the one list, enforced twice (PRESERVE THIS)
    occupancy.ts     derived free/partial/inuse/issue (PRESERVE THIS)
    format.ts
components/
  ui/                Button, Table, Chip, Avatar, StatTile, Notice, Modal…
  chat/              ConversationList, MessageList, Composer, TypingRow, PresenceDot
  providers/
    PusherProvider.tsx
    SessionProvider.tsx
vercel.json          cron definitions
```

### What survives from the old codebase, conceptually

- `shared/data.js` → `lib/shared/roles.ts` + `lib/shared/occupancy.ts` + `lib/jira/matching.ts`.
  **The "one capability list read by both sides" pattern must be preserved.**
- `public/js/ui/tokens.js` → Tailwind theme tokens + a `tokens.ts` for labels/icons.
- `public/js/ui/html.js` → `components/ui/*`.
- `public/js/ui/model.js` → server-side query functions + view-model mappers.
- `server/access.js` → `lib/auth/require.ts`.
- Migrations in `shared/data.js` `migrateAppData()` → **run once** during the data import
  (Phase 3), then deleted. They exist to upgrade old on-disk shapes; Postgres has a schema.

---

## 4. Neon Postgres

**Two access modes, and picking the wrong one per call site is the classic serverless mistake.**

| Mode | Import | Use for |
|---|---|---|
| HTTP (one-shot) | `neon()` from `@neondatabase/serverless` | Single `SELECT`/`INSERT`. No connection setup. The default. |
| Pooled (WebSocket) | `Pool` from `@neondatabase/serverless` | Anything needing a **transaction** or multiple statements that must be atomic |

Rules:

- Use the **pooled connection string** (`...-pooler.<region>.aws.neon.tech`) for the `Pool` mode.
  A serverless function must never open a direct unpooled TCP pool — invocations scale out and exhaust
  Postgres connections.
- Create the client **per invocation**, module-scope is fine for the HTTP driver (it is stateless
  `fetch`), but never cache a `Pool` across invocations expecting it to be warm.
- Every multi-statement write goes in a transaction. Sending a chat message is
  `INSERT message` + `UPDATE conversations.last_message_at` + `UPDATE sender watermark` — one
  transaction, then publish to Pusher **after commit**.
- Migrations are **forward-only numbered SQL files**, applied by a script, tracked in a
  `schema_migrations` table. No ORM auto-sync. `@neondatabase/serverless` is already the (stale)
  lockfile entry, so it is the intended driver.

**Publish after commit, never inside the transaction.** If the transaction rolls back after you have
already told Pusher a message exists, every client shows a message the database does not have.

---

## 5. The IP allowlist under Vercel

This is a real semantic change and it must not be lost, because it is currently the outermost layer of
the security model.

On Vercel, **every request arrives from the Vercel edge**, so the socket peer is useless and the
current `TRUST_PROXY`-off-by-default stance inverts: there is now always exactly one trusted hop in
front, so `x-forwarded-for` **must** be read — but only the entry the platform itself set.

Two layers, and the first is strictly better than what exists today:

1. **Vercel Firewall / platform IP rules** (preferred where the plan allows — *verify*). Blocks at the
   edge before a function is invoked. Cheaper, and it cannot be bypassed by an app bug.
2. **`middleware.ts` allowlist** — the portable fallback and the thing that keeps behaviour identical
   to today. Reads the client IP from the platform header, checks it against the rules, and returns a
   bare `403` for every path. Config from an `ALLOWED_IPS` env var (the file-based
   `config/allowed-ips.json` cannot survive — no writable disk), which also means **hot-reload by
   editing a file is gone**; changing the list is now a redeploy or an env-var update.

Behaviours to consciously re-decide, since the old rationale changes:

- The `lan` alias is meaningless for a public deployment.
- `loopback` is always-allowed today so the host can reach its own portal. There is no host now.
- The **"empty list means not configured, not nobody"** fail-open rule (which exists so a missing env
  var can't lock the team out) is more dangerous on a public URL than on a LAN. See
  [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q3.

---

## 6. Auth on Vercel

**Keep opaque session tokens in Postgres. Do not switch to stateless JWTs.** Rationale in
[ADR-004](05-DECISIONS.md#adr-004): the app's documented behaviour is that changing a password, a role,
or an account's active flag **immediately** invalidates every open session. A stateless JWT cannot be
revoked before it expires without a server-side denylist — which is a session table with extra steps.

Design:

- `auth_users` and `auth_sessions` tables (see [02-DATA-MODEL.md](02-DATA-MODEL.md)).
- `scrypt` + per-user salt + `timingSafeEqual`, unchanged, on the **Node runtime**.
- Cookie stays `sm_session`, `HttpOnly`, `SameSite=Lax`, `Path=/` — and now **`Secure` must be set**,
  because Vercel is HTTPS. The old comment explaining why `Secure` was omitted no longer applies.
- `resolveSession(token)` is one indexed `SELECT … JOIN auth_users` — replacing the current
  read-the-whole-file-per-request. Reject expired, reject `active = false`.
- `revokeSessionsFor(userId)` is one `DELETE`.
- The login lockout counter is currently **in memory**, which does not survive a stateless platform.
  It must move to Postgres (`auth_login_attempts`) or be dropped. Recommend moving it — it is the only
  brute-force defence in the app.

---

## 7. Realtime with Pusher (summary)

Full specification in [03-REALTIME-SPEC.md](03-REALTIME-SPEC.md). The architectural points:

- **Server publishes, client subscribes.** No route handler ever holds a connection open.
- **Channel types carry the authorization**, which is exactly what the old SSE channel lacked:
  - `presence-org` — one per deployment. Presence membership *is* the online/offline feature.
  - `private-conv-<conversationId>` — a DM or group. Subscription is authorized against
    `conversation_members`, so a private message physically cannot reach a non-member.
  - `private-user-<authUserId>` — that person's notifications and unread counts.
  - `board` (public-ish, still auth-gated by the subscribe endpoint) — replaces the whole-board SSE
    push with **granular** events.
- **`/api/pusher/auth`** is the new authorization chokepoint. It validates the session, then validates
  membership for the requested channel. This endpoint is security-critical: a bug here leaks DMs.
- **Never push a full row of sensitive data if a signal will do.** Pusher payloads are capped
  (~10 KB default, *verify*) and every payload is a copy of your data leaving your infrastructure.
  Prefer `{ conversationId, messageId }` + client refetch for anything large; inline the message body
  only because chat latency demands it, and only after deciding that is acceptable
  ([06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q7).
- **The old full-board broadcast must not be reimplemented as a Pusher event.** It would blow the
  payload cap, burn message quota every 20 seconds, and re-leak everything to everyone. Granular
  events + `router.refresh()` or a targeted refetch instead.

---

## 8. Media with Vercel Blob

- **Client-upload flow is mandatory, not optional.** Vercel serverless request bodies are capped
  (~4.5 MB, *verify*), so files must go **browser → Blob directly**, using a short-lived upload token
  minted by `/api/chat/attachments/upload-url`. That route is where the capability check, MIME
  allowlist, and size cap live.
- **Blob URLs are unguessable but publicly readable** (*verify current access modes*). Treat a Blob URL
  as a **capability URL**: whoever holds it can read the file, forever, regardless of conversation
  membership. For QA screenshots of internal environments that may be acceptable; decide explicitly
  ([06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q6). If it is not, proxy downloads through
  `/api/chat/attachments/[id]` and never hand the raw Blob URL to the client.
- Store Blob metadata in Postgres (`chat_attachments`), never only in Blob. The DB row is the record;
  the blob is the bytes.
- Deleting a message must also delete the blob, or you accumulate orphaned billable storage. A
  retention cron reconciles.

---

## 9. Scheduled work with Vercel Cron

`vercel.json` declares the schedules; each points at a route under `app/api/cron/`.

| Job | Today | Target |
|---|---|---|
| Health checks | `setInterval` 30 s | `/api/cron/health` — **see the blocker below** |
| Jira sync | 20 s tick, throttled to `pollIntervalMinutes` | `/api/cron/jira-sync`, **1 minute floor** |
| Claim expiry | `setInterval` 30 s | `/api/cron/expiry`, 1 minute |
| Blob/message retention | n/a | `/api/cron/retention`, daily |

Three things to plan around:

1. **Cron frequency has a floor and a plan limit** (*verify*: Pro allows per-minute; Hobby is far
   coarser and caps the number of cron jobs). A 20-second Jira poll is **not achievable**. Sub-minute
   freshness has to come from the existing user-triggered "Sync now" button instead.
2. **Cron routes must be authenticated.** They are public URLs. Verify Vercel's cron secret header
   (or a `CRON_SECRET` bearer token) and reject anything else — otherwise anyone can trigger a Jira
   sync or an expiry sweep at will.
3. **Cron invocations are subject to function timeouts.** The Jira sync pages up to 500 issues plus a
   field-map lookup. Keep it under the limit or make it resumable (checkpoint the page cursor).

### ⚠ The health-check blocker

The current health checks `fetch` URLs like `https://backend.srv-01.internal`. **A Vercel function
cannot reach a private hostname on your network.** This feature does not degrade under the migration —
it stops working entirely, and every environment reads `offline`, which then outranks claim state in
`getDisplayStatus()` and paints the whole board red.

This needs a decision before Phase 5. Options in [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q1:
an on-prem agent that POSTs results in, publicly-reachable health URLs, or dropping the feature.

---

## 10. Data flow, end to end

### Reading the board

```
Server Component → lib/db/queries/board.ts → Neon (HTTP driver) → render
```

No client-side fetch, no `appData` blob, no `localStorage` cache. This deletes an entire class of
staleness bug.

### Mutating the board (replaces the whole-board POST)

```
Client action → route handler
                 ├─ requireUser("claim")            capability boundary
                 ├─ validate input
                 ├─ BEGIN … targeted UPDATE … COMMIT   one row, not the board
                 ├─ publish granular Pusher event      after commit
                 └─ 200
Other tabs ← Pusher event → invalidate/refetch that slice
```

**Granular endpoints are the whole point.** The old `POST /api/state` was last-write-wins over the
entire board; `UPDATE claims SET … WHERE id = $1` cannot clobber an unrelated concurrent edit. This
migration fixes the app's worst existing bug as a side effect — see
[00-CONTEXT-CURRENT-SYSTEM.md](00-CONTEXT-CURRENT-SYSTEM.md) "Known problems" #1.

### Sending a chat message

```
Composer (optimistic render, client_msg_id generated locally)
  → POST /api/chat/conversations/:id/messages
      ├─ requireUser("chat")
      ├─ assert membership in conversation_members     ← authorization boundary
      ├─ rate-limit check
      ├─ BEGIN
      │    INSERT chat_messages … ON CONFLICT (conversation_id, client_msg_id) DO NOTHING
      │    UPDATE chat_conversations SET last_message_at
      │    UPDATE chat_members SET last_read_message_id (sender reads own message)
      │  COMMIT
      ├─ publish  private-conv-<id>   "message.new"
      ├─ publish  private-user-<uid>  "unread.changed"  (per other member)
      └─ 200 { id, createdAt }
Composer reconciles optimistic row by client_msg_id
```

`ON CONFLICT DO NOTHING` on `(conversation_id, client_msg_id)` makes retries idempotent — a dropped
response on a flaky connection must not double-post.
