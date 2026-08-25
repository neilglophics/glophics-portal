# 05 — Decision record

Short ADRs. Each records what was decided, why, and **what it costs** — the consequences section is the
part worth reading in six months.

---

## ADR-001 — Move to Next.js + Vercel + Neon + Pusher + Vercel Blob

**Status:** Accepted (team directive)

**Context.** The app today is a zero-dependency Node process serving vanilla JS, storing JSON on local
disk, pushing state over its own SSE stream. It works, and it is unusually well-documented internally.
But it needs a host running a persistent process, it has no build step (Tailwind compiles in the
browser from a CDN), no tests, and a whole-board last-write-wins write path. Chat, media and presence
are on the roadmap.

**Decision.** Rebuild on Next.js (App Router, TypeScript) hosted on Vercel, with Neon Postgres as the
only source of truth, Pusher Channels for realtime, and Vercel Blob for media.

**Consequences — good.**
- Postgres replaces whole-board replacement with row-level writes, which **removes the app's worst
  existing bug** (concurrent edits clobbering each other) as a side effect.
- A real build step retires the runtime Tailwind CDN compile the README already flags as
  non-production.
- TypeScript makes the "one capability list, enforced twice" pattern a compile-time guarantee rather
  than a convention.
- Managed realtime removes four latent SSE defects at once: no addressing, no heartbeat, no replay, no
  re-authentication of an open stream.

**Consequences — costs, stated plainly.**
- ~~⚠ **Health checks against `*.internal` hostnames stop working.**~~ **Did not materialise
  (2026-08-21).** No configured URL is on an internal hostname; they are all public dev domains, so a
  Vercel function reaches them. The cost that remains is cadence, not reachability: hourly from the
  page timer, daily from cron unless the plan allows better. This becomes a real outage the day an
  environment on a private hostname is added — an offline repo still outranks everything in
  `getDisplayStatus()`. [Q1](06-OPEN-QUESTIONS.md#q1).
- ⚠ **Sub-minute Jira freshness is lost.** The current 20-second poll is not achievable under cron
  scheduling. [Q10](06-OPEN-QUESTIONS.md#q10).
- The IP allowlist changes character: no hot-reload by editing a file, and it can no longer terminate
  an already-established realtime connection. [Q3](06-OPEN-QUESTIONS.md#q3).
- Data leaves the local network — Neon, Pusher and Blob all hold internal environment URLs, ticket
  keys, and (for Pusher) message bodies. That is a genuine change in posture for a tool that was
  deliberately LAN-only behind an IP gate.
- Four external services to provision, bill and monitor, each with quotas that can throttle the app.
- The `localStorage` fallback that kept the board readable when the server dropped is gone.
- Zero dependencies becomes many. The `node_modules`-free property is deliberately traded away.

**Superseded.** An earlier analysis in this repo recommended extending the existing SSE channel and
adding `node:sqlite`, preserving zero dependencies and the persistent-process model. That option is
**superseded by this ADR** and recorded here only so the reasoning is not rediscovered: it optimised
for keeping the current architecture, which the team has decided not to keep.

---

## ADR-002 — Pusher Channels, not SSE or raw WebSockets

**Status:** Accepted

**Context.** Realtime on a serverless platform. Three candidates: keep SSE, run WebSockets, or use a
hosted service.

**Decision.** Pusher Channels.

**Why.** SSE and WebSockets both require the server to **hold a connection open**, which is precisely
what a serverless function does not do — the function would have to stay alive per connected client,
billed for the duration, and would still lose every connection on redeploy. A hosted realtime service
inverts the model: the server publishes and returns immediately, and the connections live somewhere
else. On Vercel this is not a preference, it is close to a requirement.

Pusher specifically also solves the thing the old channel most lacked: **channel types that carry
authorization**. `private-` and `presence-` prefixes plus a server auth endpoint give per-conversation
access control, which is the prerequisite for any private message existing at all.

**Consequences.**
- Message payloads transit a third party. Mitigable with `private-encrypted-` channels.
  [Q7](06-OPEN-QUESTIONS.md#q7).
- **No replay.** Anything published while a client was disconnected is lost to that client, so every
  feature needs an explicit catch-up path ([03-REALTIME-SPEC.md](03-REALTIME-SPEC.md) §7). This is the
  single easiest way to ship a chat that silently drops messages.
- Connection and message quotas become a design constraint; noisy publishers (health cron, unread
  notifications, typing) must be budgeted.
- ⚠ Presence channels cap at roughly 100 members — a hard ceiling on `presence-org`.
- `/api/pusher/auth` becomes the most security-critical file in the codebase.

---

## ADR-003 — Neon Postgres as the single source of truth

**Status:** Accepted

**Decision.** All state — board, auth, chat — in Neon. Nothing on local disk.

**Why.** Vercel has no writable persistent disk and no shared process memory, so `shared-data/*.json`,
`config/auth.json` and the in-memory `Board.state` singleton all have nowhere to live. Postgres also
buys what JSON files cannot: real indexes, keyset pagination for message history, transactions, and
constraints that make invariants like "one login per person" and "one DM per pair" enforceable by the
database rather than by racy application checks.

**Consequences.**
- Every read is a network call. Server Components make this cheap (no client round trip), but the
  pooled-versus-HTTP driver choice per call site now matters, and getting it wrong exhausts Postgres
  connections under scale-out.
- `state-store.js`'s careful work — atomic rename per section, skip-if-unchanged, coalescing,
  quarantine of an unreadable board — becomes irrelevant. Worth acknowledging: that machinery existed
  for good reasons and Postgres subsumes all of them.
- The Jira-derived cache must now be **persisted** (ADR-010).

---

## ADR-004 — Opaque session tokens in Postgres, not JWTs

**Status:** Accepted

**Context.** Serverless nudges toward stateless JWTs to avoid a per-request session lookup.

**Decision.** Keep opaque random tokens, stored as **SHA-256 hashes** in `auth_sessions`, resolved by
one indexed query per request.

**Why.** The app's documented, load-bearing behaviour is that changing a password, changing a role, or
deactivating an account **immediately** ends every session that person holds — the README states it as
a feature: "an open tab loses the access it had rather than keeping it until reload." A stateless JWT
cannot be revoked before expiry without a server-side denylist, which is a session table with extra
steps and worse ergonomics.

Storing the hash rather than the token is a **strict improvement** on the current system, where
`config/auth.json` holds live plaintext tokens beside the password hashes.

**Consequences.** One indexed lookup per authenticated request — cheaper than today's
`readFileSync` + `JSON.parse` of the whole credential file per request. Session validation cannot run
in Edge middleware, which is why middleware only checks cookie *presence* and the real boundary is
`requireUser()` on the Node runtime.

---

## ADR-005 — Granular mutation endpoints; no whole-board write

**Status:** Accepted

**Decision.** `POST /api/state` is not reimplemented. Each entity gets endpoints that touch only the
rows they name, inside a transaction.

**Why.** The current write path POSTs the entire board and replaces it in one assignment — last-write-
wins with no version or ETag. Two people editing at once means one silently loses their change. It is
made worse by `setFilter` calling the same save path, so typing in the search box POSTs the whole board.

**Consequences.** More endpoints to write and authorize. In exchange, concurrent edits stop clobbering,
payloads shrink from the whole board to one entity, role enforcement becomes per-operation instead of
"strip the fields they may not touch", and realtime events become naturally granular — which is what
makes [ADR-002](#adr-002)'s small payloads possible.

---

## ADR-006 — Read state as a watermark, not a receipts table

**Status:** Accepted

**Decision.** `chat_members.last_read_message_id`. No per-message receipt rows.

**Why.** A receipts table is O(messages × members) rows to power a feature that renders as one tick and
a bold conversation title. A watermark is O(members) and answers unread counts with
`COUNT(*) WHERE id > last_read_message_id`, which the existing
`chat_messages (conversation_id, id DESC)` index already serves.

**Consequences.** You cannot show *which* specific members have read a *specific* older message —
only "read up to here". That is enough for every requirement currently on the table. If per-recipient
per-message ticks are later required, add `chat_message_receipts` then, deliberately, with the cost
understood.

---

## ADR-007 — Chat participants keyed on `auth_users.id`

**Status:** **Proposed** — pending [Q4](06-OPEN-QUESTIONS.md#q4)

**Context.** The app has two independent identity spaces: auth accounts (who can sign in) and board
directory people (who can be assigned a claim), optionally linked one-to-one. **Most people on the
board have no login at all.**

**Decision (proposed).** Chat membership, message senders and presence key on `auth_users.id`. Display
name and avatar resolve through `directory_user_id` when the link exists.

**Why.** You can only usefully chat with someone who can read it. A conversation keyed on directory
people would let you address colleagues who can never open the app — messages sent into a void, unread
counts that never clear.

**Consequences.** Giving someone chat access means giving them a login. The Users page already frames
this correctly ("No login — give access"), so the workflow exists. It does mean the reachable set for
chat is smaller than the assignable set for claims, and the UI must not imply otherwise.

---

## ADR-008 — Authorization in the application layer, not Postgres RLS

**Status:** Accepted

**Decision.** `requireUser(capability)` plus an explicit `chat_members` check. One database role, one
connection string. No row-level security.

**Why.** The app is the only client of this database, and the capability list is already shared between
client and server. RLS would mean threading a per-request identity through Neon's pooled connection
model for no gain today.

**Consequences.** A missing `WHERE` clause on `chat_messages` is a privacy incident with no second net
beneath it. Two rules become non-negotiable: no query against `chat_messages` without a proven
membership check on the same request, and `/api/pusher/auth` is that same boundary in a different
shape. **Revisit this ADR the moment a second client touches the database** — a BI tool, another
service, or direct SQL for support.

---

## ADR-009 — Typing indicators via the server, not Pusher client events

**Status:** Accepted

**Decision.** `POST /api/chat/typing`, server-published. Client events stay disabled in the Pusher app.

**Why.** Client events let any subscriber publish onto a channel it is subscribed to, invisibly to the
server. A forged `typing.start` is harmless in isolation, but the capability cannot be scoped to one
event name — enabling it enables client publishing app-wide, which is a standing hazard as the event
vocabulary grows. At this team's scale the function invocations are trivial.

**Consequences.** One invocation per typing ping, throttled to one per 3 seconds per user per
conversation. Typing remains the highest-frequency event in the system, so that throttle is what keeps
it affordable.

---

## ADR-010 — Persist the Jira-derived cache

**Status:** Accepted

**Context.** `jiraIssues`, `jiraSkipped` and `lastJiraSyncAt` are currently and **deliberately never
persisted**: they are most of the board by size, stale the moment the process stops, and refilled from
memory by the sync at boot.

**Decision.** They become `jira_issues`, `jira_skipped` and `jira_sync_state` tables.

**Why.** There is no process to hold them. The alternative is re-querying Jira on every page view that
shows a ticket table, which is slower, rate-limited, and fails when Jira does.

**Consequences.** The board's on-disk size grows substantially. These tables are a **cache, not a
source of truth**: each sync pass truncates and refills, nothing joins to them with referential
integrity, and array columns are acceptable there for exactly that reason. They must never be read as
authoritative for occupancy — `claims` is.

---

## ADR-011 — Soft-delete messages

**Status:** Accepted

**Decision.** `chat_messages.deleted_at`. Hard deletion only via the retention cron.

**Why.** `reply_to_id` targets must survive, and message ordering by `bigserial` should not develop
holes that break cursor pagination. It also makes "message deleted" renderable, which is what users
expect.

**Consequences.** Deleted content stays in the database until retention removes it, which is a real
consideration for the privacy policy [Q8](06-OPEN-QUESTIONS.md#q8) — "delete" in the UI is not
immediately "gone from the database", and saying so honestly matters. Attachment blobs must be deleted
by the same job, or they become billable orphans.

---

## ADR-012 — `oversee`: a sixth capability, for the team task viewer

**Status:** Accepted

**Context.** `/team` answers the question a project manager asks and no existing page does: not "who
holds environment 4", but "what is Jerome on, and is anybody free". It needs to be visible to a lead
and not to the team it reports on.

The obvious shortcut was to gate it on `manage-users`, which today only `superadmin` holds. That would
have been zero new surface — and wrong. `manage-users` means *can create a login and hand out a role*.
Reading everyone's workload is a different power that happens to belong to the same person right now.
Conflating them means the day `admin` is given `manage-users` — a plausible, small decision — this page
silently widens with it, and nobody reviewing that change would see it coming.

**Decision.** A new capability, `oversee`, granted to `superadmin` alone. Checked by
`requireUser("oversee")` in both `/team` Server Components and by `requires: "oversee"` on the nav
entry.

**Why a capability and not a role check.** Invariant 3: one capability list, enforced twice. A
`user.role === "superadmin"` test in a page would be a third boundary, invisible to `AUTH_ROLES`, and
the first thing to drift. Adding to the list means the Users page's role card describes the new power
without being edited.

**Scope — what this deliberately does not grant.** `/team` reads the board and the Jira cache. It shows
**no chat**, and holding `oversee` gives no access to any conversation:
[Q5](06-OPEN-QUESTIONS.md#q5) says membership is the boundary and a silent superadmin bypass is
indistinguishable from the bug that boundary exists to prevent. That answer is unchanged here. Q5 also
says *whatever the answer, say it in the UI*, so the page says in as many words that it reads tickets
and not messages.

**Consequences.** Widening to `admin` later is one array entry, which is the point. The cost is that
"superadmin" is now two separable things and somebody could grant one without the other — that is a
feature, but it does mean the capability list is the thing to read, not the role name. There is no
audit log of who looked; if that is ever wanted it is a new decision, not an extension of this one.
