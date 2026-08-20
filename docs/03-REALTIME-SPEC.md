# 03 — Realtime specification (Pusher Channels)

How every live update in the app travels, once Pusher replaces the SSE stream.

> Platform limits quoted here are marked *verify* and must be confirmed against current Pusher docs
> before they are load-bearing. The ones that would actually change the design are flagged ⚠.

---

## 1. Principles

1. **The server publishes and returns. Nothing holds a connection open.** This is the whole reason
   Pusher is in the stack — a serverless function cannot own a long-lived stream.
2. **Channel type carries the authorization.** The old SSE channel had no addressing at all, so it
   could not carry anything private. Here, a private message is only ever published to a channel whose
   subscription was authorized against `chat_members`.
3. **Publish after commit.** Never inside the transaction. If it rolls back after Pusher has been
   told, every client renders a message the database does not have.
4. **Events are signals, not state transfer.** Small payloads. The database stays the source of truth
   and the client refetches when a signal implies more than the payload carries.
5. **Never re-implement the full-board broadcast.** The old design pushed the entire board to every
   tab on every change. Doing that through Pusher would blow the payload cap, burn message quota every
   cron tick, and re-leak everything to everyone.
6. **Pusher has no replay.** A client that was disconnected missed those events permanently. Every
   feature needs a catch-up path (§7). This is the single most common way a chat app loses messages.

---

## 2. Channels

| Channel | Type | Who may subscribe | Carries |
|---|---|---|---|
| `presence-org` | presence | any session with the `chat` capability | online/offline for the whole team |
| `private-user-<authUserId>` | private | only that user | unread counts, invites, forced sign-out |
| `private-conv-<conversationId>` | private | rows in `chat_members` for that conversation | messages, typing, read receipts |
| `private-board` | private | any session with `view` | granular board changes |

Naming notes:

- Pusher reserves the `presence-` and `private-` prefixes to select the auth behaviour — they are not
  a convention, they are the mechanism.
- Channel names permit `a-z A-Z 0-9 _ - = @ , . ;`. UUIDs are fine.
- `private-board` is private rather than public **on purpose**: a public channel needs no auth
  endpoint, so anyone who learned the Pusher app key could subscribe and watch internal environment
  URLs and ticket keys go by. The app key ships to the browser, so treat it as public knowledge.

⚠ **Presence channels cap at ~100 members** (*verify*). Fine for one QA team; it is a hard ceiling on
`presence-org` if the org grows, and the failure mode is a silent subscription rejection. If that
becomes a risk, shard presence by account or drop to a heartbeat-plus-`last_seen_at` model.

---

## 3. Subscription authorization — `/api/pusher/auth`

**This endpoint is the security boundary for all of chat.** A membership bug here leaks live private
messages to a subscriber, and no amount of correct SQL elsewhere will catch it.

`pusher-js` POSTs `socket_id` and `channel_name`; the cookie rides along same-origin.

```
POST /api/pusher/auth
  socket_id, channel_name

1. resolveSession(cookie) → user, or 403. Never 401 here; pusher-js treats
   any non-200 as a failed subscription, and a 401 invites a redirect loop.
2. requireCapability(user, "chat") for presence-org / private-conv-*
   requireCapability(user, "view") for private-board
3. Parse the channel name into a typed descriptor. REJECT anything unparseable —
   never fall through to "allow" on an unrecognised channel shape.
4. Per channel type:
     presence-org          → authorize, with presence data (see below)
     private-user-<id>     → authorize ONLY IF id === user.id        ← exact match
     private-conv-<id>     → SELECT 1 FROM chat_members
                             WHERE conversation_id = $1 AND user_id = $2
     private-board         → authorize
5. Return pusher.authorizeChannel(socket_id, channel_name, presenceData?)
```

Rules for this file specifically:

- **Default deny.** The parser returns a union; an unmatched case throws, it does not warn and continue.
- **`private-user-<id>` must be an exact id comparison**, not a prefix or `startsWith` test.
  `private-user-abc` must not authorize `private-user-abcd`.
- Presence data must contain **only what other members are allowed to see**:
  ```ts
  { user_id: authUser.id,
    user_info: { displayName, role, directoryUserId } }
  ```
  Everything in `user_info` is broadcast to every other presence member. No username, no email, no
  session detail.
- Do not skip the membership query for `superadmin`. If admins are meant to read any conversation
  that is a product decision ([06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q5), and it belongs in an
  explicit, logged code path — not as a silent bypass in the auth endpoint.

---

## 4. Event catalogue

All names are `namespace.verb`. The union lives in `lib/realtime/events.ts` and is imported by both
the publisher and the subscriber, so a renamed event breaks the build rather than the feature.

### Chat — on `private-conv-<conversationId>`

| Event | Payload | Persisted |
|---|---|---|
| `message.new` | `{ id, conversationId, senderId, clientMsgId, body, kind, replyToId, createdAt, attachments[] }` | yes |
| `message.edited` | `{ id, conversationId, body, editedAt }` | yes |
| `message.deleted` | `{ id, conversationId, deletedAt }` | soft |
| `typing.start` | `{ conversationId, userId }` | **no** |
| `read.changed` | `{ conversationId, userId, lastReadMessageId }` | watermark only |
| `member.added` / `member.removed` | `{ conversationId, userId }` | yes |

`message.new` **inlines the body** — chat latency does not tolerate a signal-then-refetch round trip.
That is a deliberate trade: message text leaves your infrastructure and transits Pusher. It is the
one place the "signals not state" rule is broken, and it needs an explicit yes
([06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q7). If the answer is no, use Pusher's
`private-encrypted-` channels, which encrypt payloads end-to-end so Pusher cannot read them.

There is no `typing.stop`. The client starts a ~4-second timer on `typing.start` and lets it lapse.
A stop event doubles the message volume of the noisiest event in the system to convey nothing a
timeout cannot.

### Notifications — on `private-user-<authUserId>`

| Event | Payload |
|---|---|
| `unread.changed` | `{ conversationId, unreadCount, lastMessagePreview }` |
| `conversation.added` | `{ conversationId }` — you were added; go subscribe |
| `session.revoked` | `{}` — password/role/active changed; the client reloads to the sign-in screen |

`session.revoked` closes a real gap. In the current system a revoked session keeps receiving pushes
until its stream happens to drop, because the client only re-checks on disconnect. Publishing this
from `revokeSessionsFor()` makes revocation immediate and visible.

### Board — on `private-board`

Replaces the whole-board SSE frame with granular events. Each is small, and each names the slice to
refetch.

| Event | Payload | Published by |
|---|---|---|
| `claim.created` | `{ claimId, serverId, repos[] }` | claim route |
| `claim.released` | `{ claimId, serverId, repos[] }` | force-free, expiry cron |
| `claim.updated` | `{ claimId, serverId, status }` | Jira sync cron |
| `server.health` | `{ serverId, repoName, health, checkedAt }` | health cron |
| `server.changed` / `account.changed` / `directory.changed` | `{ id }` | config routes |
| `note.changed` | `{ serverId, repoName }` | notes route |
| `jira.synced` | `{ lastSyncAt, issueCount, skippedCount }` | Jira sync cron |
| `settings.changed` | `{}` | settings route |

The health cron touches many repos per pass. **Batch those** — Pusher accepts up to 10 events per
`triggerBatch` call (*verify*) — or coalesce a pass into a single `server.health.bulk` event carrying
the changed rows. Publishing one event per repo per 30 seconds is how a message quota disappears.

---

## 5. Excluding the originator (`socket_id`)

Every mutating request should send the client's Pusher `socket_id`, and every publish should pass it
as `socket_id` so Pusher excludes that connection from the fan-out.

Without this, the sender receives their own `message.new`, and a composer doing optimistic rendering
either shows the message twice or has to de-duplicate on `clientMsgId` anyway. Excluding the
originator is one field on the request and removes the whole class of problem.

```
POST /api/chat/conversations/:id/messages
  { clientMsgId, body, socketId }   ← socketId from pusher.connection.socket_id
```

The server still returns the canonical row in the response, so the sender reconciles from its own
200 rather than from an event.

---

## 6. Typing indicators

- Fire on the **first** keystroke, then at most **once every 3 seconds** while still typing.
  Client-throttled — never per keystroke.
- Suppress entirely when the composer is empty or the conversation is not focused.
- Receiver holds a `Map<userId, timeoutId>` and clears the row after ~4 seconds with no further event.
- Never written to Postgres. Never rendered from anything but live events.

Two ways to send, and the choice is a real trade-off:

| | Server-triggered (`POST /api/chat/typing`) | Pusher client events (`client-typing`) |
|---|---|---|
| Cost | One function invocation per ping | Zero function invocations |
| Quota | Counts as a message | Counts as a message |
| Trust | Server validates membership | ⚠ Client can publish to any channel it is subscribed to |
| Auditability | Logged like any request | Invisible to the server |

**Recommendation: server-triggered.** Typing volume at this team's scale is trivial, and client events
mean a subscriber can inject arbitrary events into a channel — a member of one conversation forging a
`typing.start` is harmless, but the same capability is a hazard if the event vocabulary later grows.
Client events also require enabling them app-wide in the Pusher dashboard, which cannot be scoped to
just this one event.

---

## 7. Reconnection and catch-up (mandatory)

**Pusher does not replay missed events.** Anything published while a client was disconnected is gone
for that client. Every consumer therefore needs a catch-up path, and it must be wired from the start —
retrofitting it means shipping a chat that silently drops messages on every laptop-lid close.

Client state machine:

```
connecting  → show the offline dot
connected   → subscribe, then CATCH UP (below), then render live
unavailable → offline dot; pusher-js keeps retrying with backoff
failed      → offer a manual reload
```

On every transition into `connected` — including the first — run catch-up:

| Slice | Catch-up call |
|---|---|
| Open conversation | `GET /api/chat/conversations/:id/messages?after=<lastSeenMessageId>` |
| Conversation list | `GET /api/chat/conversations` (cheap; refetch wholesale) |
| Board | `router.refresh()`, or refetch the active page's data |
| Presence | Arrives automatically — `pusher:subscription_succeeded` carries the full member list |

`lastSeenMessageId` is the highest `chat_messages.id` the client has rendered for that conversation.
Because ids are a monotonic `bigserial`, `WHERE id > $cursor` is exact — no timestamp comparison, no
clock skew, no overlap window.

Presence is the easy case and worth noting: `pusher:subscription_succeeded` delivers the complete
current member list, so presence self-heals on reconnect with no extra endpoint.

---

## 8. Presence and last-seen

Online is **derived from `presence-org` membership**, not stored. The channel is the state.

Client-side handling:

- `pusher:subscription_succeeded` → seed the full online set.
- `pusher:member_added` / `pusher:member_removed` → adjust it.
- A user with several tabs appears **once**; Pusher de-duplicates by the `user_id` returned from the
  auth endpoint. This is a good reason to key presence on `auth_users.id`.

Persisting **last seen** for the offline case ("last seen 20m ago") should use **Pusher webhooks**
rather than client pings:

```
Pusher  →  POST /api/pusher/webhook   (member_removed / member_added on presence-org)
             ├─ verify the webhook signature — REQUIRED, this is a public URL
             └─ UPDATE auth_users SET last_seen_at = now() WHERE id = …
```

That is one write per genuine connect/disconnect instead of a heartbeat request per user per interval,
and it keeps working when the tab is closed — which is exactly the moment the value matters.

---

## 9. Client wiring

`components/providers/PusherProvider.tsx` — one client for the whole app, mounted in the
authenticated layout so it never exists on the sign-in screen.

```
new Pusher(NEXT_PUBLIC_PUSHER_KEY, {
  cluster: NEXT_PUBLIC_PUSHER_CLUSTER,
  authEndpoint: "/api/pusher/auth",
  forceTLS: true,
})
```

- `NEXT_PUBLIC_PUSHER_KEY` is **public by design** and ships in the bundle. The secret
  (`PUSHER_SECRET`) is server-only and must never be prefixed `NEXT_PUBLIC_`. Authorization comes from
  the auth endpoint, never from the key being secret.
- **One Pusher instance, ever.** In development, React Strict Mode double-invokes effects and Fast
  Refresh remounts; without a guard you leak connections and hit the concurrent-connection quota while
  building the feature. Hold it in a module-scope singleton or a ref, and disconnect on unmount.
- Subscribe to `presence-org`, `private-user-<me>` and `private-board` at the layout level; subscribe
  to `private-conv-<id>` in the conversation view and **unsubscribe on unmount**.
- Route each event to a cache invalidation, not to a hand-maintained store. With App Router that means
  `router.refresh()` for server-rendered slices; the message list is the exception and keeps its own
  append-only local list, because refetching a paginated thread on every message is both slow and
  scroll-destroying.

### The one piece of UI that must not re-render wholesale

The message list. Everything else in this app can repaint freely — the old design repainted the whole
page on every change and got away with it. A message list cannot: a full re-render on every incoming
message destroys scroll position, kills text selection, and interrupts the composer.

Append incoming messages to a local list keyed by `id` (reconciling optimistic rows by
`clientMsgId`), and let pagination prepend older pages. Keep it out of whatever refresh mechanism the
rest of the page uses.

---

## 10. Rate limits and quotas

There is **no rate limiting anywhere in the current app** except the login lockout, and chat
introduces the first endpoints where that is dangerous.

Enforce server-side, per user, in Postgres or a small counter table:

| Action | Suggested limit |
|---|---|
| Send message | 20 / 10 s |
| Typing ping | 1 / 3 s (also throttled client-side) |
| Create conversation | 10 / hour |
| Upload token request | 20 / hour |
| Mark read | 10 / 10 s |

⚠ **Pusher plans cap concurrent connections and daily messages** (*verify* — the free tier is
commonly 100 connections / 200k messages per day). Budget the noisy publishers before shipping:

- Health cron: batch or coalesce, or one pass across many repos becomes dozens of messages every
  interval.
- `unread.changed`: published per non-sender member per message. A 10-person group chat multiplies
  every message by 10. Consider coalescing or letting the client derive unread from `message.new` on a
  channel it already listens to.
- Typing: the highest-frequency event in the system. The 3-second throttle is what keeps it affordable.

Add a `lib/realtime/server.ts` wrapper that counts publishes per request and logs anything that fans
out more than a handful of events, so a quota problem is found in development rather than on the day
the team grows.

---

## 11. Mapping the old SSE behaviour forward

| Old behaviour | Target |
|---|---|
| `GET /api/events` SSE, full board per frame | `private-board`, granular events |
| No addressing | Channel type + `/api/pusher/auth` |
| No heartbeat, dies at ~60 s behind a proxy | Pusher's own keepalive |
| No replay | §7 catch-up on every `connected` |
| Open stream never re-authenticated | Auth on every subscribe, plus `session.revoked` |
| IP allowlist re-checked per broadcast | Edge middleware on the auth endpoint; ⚠ an **established** Pusher connection is not re-gated by your IP rules — see [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) Q3 |
| `localStorage` board cache for server-down | Dropped. Neon is the source of truth; offline shows an offline state. |

That last IP row is a genuine regression to weigh, not a detail. Today `Board.broadcast()`
re-checks the allowlist on every frame and hangs up on an address that was removed from the list
mid-session. With Pusher, the connection is between the browser and Pusher's edge — your allowlist
gates the *auth endpoint* and page loads, but it cannot terminate a subscription that is already
established. Revocation now depends on `session.revoked` and on the connection eventually
re-authorizing, not on the network gate.
