# 06 — Open questions

Each has a recommendation. **Blocking** ones change the schema or the architecture and must be answered
before the phase named; the rest can be decided as their phase arrives.

Record answers **in this file**, with a date, and update the ADR in
[05-DECISIONS.md](05-DECISIONS.md) if the answer contradicts one.

| | Question | Blocks | Status |
|---|---|---|---|
| [Q1](#q1) | How do health checks reach internal hosts? | Phase 6 | ⛔ **Blocking** |
| [Q2](#q2) | Does `viewer` get chat? | Phase 8 | Open |
| [Q3](#q3) | IP allowlist semantics on a public URL | Phase 4 | ⛔ **Blocking** |
| [Q4](#q4) | Which identity space is a chat participant? | Phase 2 (schema) | ⛔ **Blocking** |
| [Q5](#q5) | Can admins read others' conversations? | Phase 8 | Open |
| [Q6](#q6) | Blob privacy: capability URL or proxied? | Phase 11 | Open |
| [Q7](#q7) | Do message bodies transit Pusher? | Phase 8 | Open |
| [Q8](#q8) | Retention, deletion, and what "delete" means | Phase 13 | Open |
| [Q9](#q9) | Are group chats tied to environments/tickets? | Phase 9 | Open |
| [Q10](#q10) | Acceptable Jira sync freshness | Phase 6 | Open |
| [Q11](#q11) | Is losing the offline board cache acceptable? | Phase 5 | Open |
| [Q12](#q12) | Team size ceiling vs presence cap | Phase 10 | Open |

---

## Q1 — How do health checks reach internal hosts? ⛔

**The problem.** Health checks currently `fetch` URLs like `https://backend.srv-01.internal` from the
same LAN. **A Vercel function runs in a public cloud and cannot resolve or reach a private hostname.**

This does not degrade gracefully. `getDisplayStatus()` gives an offline repo priority over everything
else, so every environment would read **"Needs attention"** and the board would be useless — a louder
failure than no health checks at all.

**Options.**

| Option | Effort | Notes |
|---|---|---|
| **A. On-prem reporting agent** | Medium | A tiny script on a machine inside the network runs the existing check loop and `POST`s results to `/api/health/report` with a shared secret. Keeps the feature intact; the network boundary is respected because the call goes outward. **Recommended.** |
| B. Publicly reachable health URLs | Low–High | Only viable if these environments already have public endpoints. Exposes internal services; probably a non-starter. |
| C. Drop health checks for now | Low | Then the UI **must** show `unknown` / "not checked", never `offline`. Losing "Needs attention" also removes the reason `issue` outranks claim state. |
| D. Cloudflare Tunnel / VPN into the network | High | Solves it properly and generally; a whole infrastructure project of its own. |

**Recommendation: A**, with C as the interim state for the first deploy — but only if the UI is honest
about it. Option A is ~50 lines reusing `server/jobs/health.js` almost verbatim, and it inverts the
direction of trust in the safer way.

**Answer:** _(pending)_

---

## Q2 — Does `viewer` get chat?

`view` should not silently imply chat. Recommend adding an explicit **`chat`** capability to
`AUTH_ROLES` so it is enforced twice by the existing mechanism (browser hides, server refuses).

Proposed:

| Role | `chat` |
|---|---|
| `superadmin` | ✔ |
| `admin` | ✔ |
| `member` | ✔ |
| `viewer` | **?** |

A `viewer` is described as "Read-only. Sees the board, changes nothing." Sending a message is a write.
**Recommendation: no chat for `viewer`** — a read-only account is often a stakeholder or a shared
screen, and neither should be able to post. Easy to reverse later; hard to un-send messages.

**Answer:** _(pending)_

---

## Q3 — IP allowlist semantics on a public URL ⛔

Three properties of the current gate change, and each needs an explicit decision.

**(a) Fail-open.** Today an empty list means "not configured", the gate stays open, and startup prints
a warning — deliberately, so a missing env var cannot lock the whole team out of a running portal on a
LAN. On a **public Vercel URL** that same rule means one missing environment variable silently exposes
the portal to the internet.
→ **Recommendation: fail closed in production, fail open in development.** Log loudly either way.

**(b) No hot-reload.** `config/allowed-ips.json` could be edited and took effect in seconds, which was
the documented escape hatch for a typo that locked everyone out. With no writable disk the list lives
in `ALLOWED_IPS`, so a change is an env-var update plus a redeploy.
→ Accept, and document the recovery path. Consider Vercel Firewall rules, which are editable in the
dashboard without a deploy.

**(c) Realtime connections are not gated.** Today `Board.broadcast()` re-checks the allowlist on every
frame and hangs up on an address removed from the list mid-session. A Pusher connection is between the
browser and Pusher's edge — your rules gate page loads and the auth endpoint, but cannot terminate an
established subscription.
→ Mitigation is `session.revoked` plus short-lived authorization, not the network gate. Worth stating
so nobody assumes the old guarantee still holds.

Also: `lan` and `loopback` aliases become meaningless, and the client IP must now be read from the
platform's forwarded header (there is always exactly one trusted hop, inverting today's
`TRUST_PROXY`-off default).

**Answer:** _(pending)_

---

## Q4 — Which identity space is a chat participant? ⛔

The app has two, and they are not interchangeable:

| | Auth account | Directory person |
|---|---|---|
| Table | `auth_users` | `directory_users` |
| Means | can **sign in** | can be **assigned a claim** |
| Coverage | a minority of the team | everyone on the board |

Linked optionally one-to-one via `directory_user_id`. **Most board people have no login.**

**Recommendation: `auth_users.id`** ([ADR-007](05-DECISIONS.md#adr-007)). You can only chat with
someone who can read it; keying on directory people would create conversations addressed to colleagues
who cannot open the app.

This is blocking because it decides the foreign keys in `chat_members`, `chat_messages.sender_id` and
the `presence-org` `user_id`. Changing it later is a data migration plus a rewrite of
`/api/pusher/auth`.

**Answer:** _(pending)_

---

## Q5 — Can admins read others' conversations?

Membership is the authorization boundary, so by default **no** — a `superadmin` sees only conversations
they belong to.

Options: (a) no override, ever; (b) an explicit, logged "open conversation as admin" action; (c) silent
access for `superadmin`.

**Recommendation: (a) for now.** If compliance later requires access, (b) — never (c). A silent bypass
in `/api/pusher/auth` is indistinguishable from the bug that endpoint exists to prevent, and it means
nobody can honestly tell the team whether DMs are private.

Whatever the answer, **say it in the UI.** If admins can read DMs, the team should know before typing.

**Answer:** _(pending)_

---

## Q6 — Blob privacy: capability URL or proxied download?

Vercel Blob URLs are unguessable but **publicly readable** (*verify current access modes*). So a Blob
URL is a **capability**: whoever holds it can read the file forever, regardless of conversation
membership, after leaving the company, or after the message is deleted.

| Option | Cost |
|---|---|
| **A. Accept capability URLs** | Zero effort. Leaked link = leaked file, permanently. |
| **B. Proxy through `/api/chat/attachments/[id]`** | Membership checked per request; revocable. Costs a function invocation per download and reintroduces a body-size path for large files (stream it). Raw URL must never reach the client. |

**Recommendation: B for anything that is not an image thumbnail**, A only if the team decides QA
screenshots of internal environments are low-sensitivity. The deciding question: would a leaked
screenshot of a staging admin panel matter?

**Answer:** _(pending)_

---

## Q7 — Do message bodies transit Pusher?

`message.new` inlines the body so delivery is one hop instead of signal-then-refetch. That means
**message text leaves your infrastructure** and passes through a third party.

| Option | Trade |
|---|---|
| **A. Inline plaintext body** | Fastest, simplest. Pusher can read message content. |
| **B. `private-encrypted-` channels** | Payloads encrypted end-to-end; Pusher cannot read them. Costs a shared encryption key in server config and rules out server-side inspection of payloads. |
| **C. Signal only, client refetches** | Nothing sensitive transits Pusher. Adds a round trip to every message — noticeable in a chat. |

**Recommendation: B.** It keeps A's latency with C's confidentiality, and the extra config is small.
Choose A only if the team is explicitly comfortable with a vendor holding chat content.

Note this interacts with Q6: attachments are already outside Pusher, so encrypting bodies while
serving blobs from capability URLs would be inconsistent.

**Answer:** _(pending)_

---

## Q8 — Retention, deletion, and what "delete" means

Chat turns informal coordination into a durable record. Decide:

1. **Retention.** Keep forever, or purge after N months? Chat about a ticket is rarely useful a year on
   and is a liability indefinitely.
2. **What "delete" means.** Messages are soft-deleted ([ADR-011](05-DECISIONS.md#adr-011)), so the UI's
   "delete" leaves the row until retention runs. Don't tell users it is gone when it is not.
3. **Editing.** Allowed? Time-limited? Is an edit history kept?
4. **Leaving.** When someone's login is removed, `sender_id` goes null and their messages remain
   (deliberately — deleting them would gut every conversation). Confirm that is wanted.
5. **Export.** Is there ever a need to hand someone their history?

**Recommendation:** 12-month retention on messages and blobs; edits allowed for 15 minutes with an
"edited" marker and no history; no export until asked for.

**Answer:** _(pending)_

---

## Q9 — Are group chats tied to environments, tickets, or free-form?

Free-form groups are simplest. But this app is full of natural conversation anchors, and a chat bolted
next to the thing being discussed is far more useful than a general channel:

- **Per environment** — "who is on Server 03 right now". Fits the environment detail page directly, and
  the answer to "can I deploy?" belongs beside the board, which is the product's whole premise.
- **Per account** — coarser.
- **Per ticket/claim** — most precise, but a claim is transient and the chat would outlive it.

**Recommendation: free-form DMs and groups first** (Phases 8–9), then **per-environment channels** as a
follow-up, created lazily on first message and keyed by `server_id`. It reuses existing ids and needs
no new concept — a `chat_conversations` row with `kind = 'group'` and a `server_id` reference.

Deferring is fine; do not design it out. Adding a nullable `server_id` to `chat_conversations` now costs
nothing and keeps the door open.

**Answer:** _(pending)_

---

## Q10 — Acceptable Jira sync freshness

Today: a 20-second tick, internally throttled by `pollIntervalMinutes` (default 1 minute). Under Vercel
Cron the floor is roughly **1 minute** (*verify per plan*; the Hobby tier is far coarser).

So: is 1-minute worst-case staleness acceptable, given the manual **Sync now** button still gives
on-demand freshness? For a board answering "is Server 03 free?", a minute seems fine — someone reading
it is about to walk over and deploy, not trading on it.

If not: options are a paid tier with per-minute cron, an external scheduler hitting the endpoint more
often, or client-side polling while the board is open.

**Recommendation:** accept 1 minute, keep **Sync now** prominent, and show "synced Xs ago" as the
current UI already does — visible staleness is much better than invisible staleness.

**Answer:** _(pending)_

---

## Q11 — Is losing the offline board cache acceptable?

Today the browser caches the board in `localStorage`, so "a server that drops mid-session does not blank
the page". With Neon as the only source of truth and Server Components rendering, that fallback is gone:
no database, no page.

**Recommendation: accept it.** The cache existed because the old server was a laptop on a LAN that
might vanish. Vercel plus Neon have their own availability, and a stale board that *looks* live is
arguably worse for this product than an honest error — someone deploying onto an environment the cache
says is free is the exact failure the app exists to prevent.

If offline reading is wanted later, that is a deliberate PWA feature with explicit "last updated"
labelling, not a silent cache.

**Answer:** _(pending)_

---

## Q12 — Team size ceiling vs the presence cap

Pusher presence channels cap at roughly **100 members** (*verify*), and `presence-org` is one channel
for the whole deployment. The failure mode is a silently rejected subscription, which reads as "presence
randomly stopped working" rather than as a limit being hit.

What is the realistic ceiling on people **with logins** (not board people — see Q4)? If it is
comfortably under 100, no action beyond a comment in `channels.ts` noting the limit.

**Recommendation:** confirm the number, add the comment, and log a warning server-side when the
authorized presence membership approaches the cap so it is discovered before users report it.

**Answer:** _(pending)_
