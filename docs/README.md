# Docs

Planning and context for the migration to **Next.js + Vercel + Neon Postgres + Pusher + Vercel Blob**,
and for the chat/realtime features being built on top of it.

**Nothing here is implemented yet.** The app running today is the vanilla Node/JSON-file version
described in doc 00. No application code has been changed.

## Read in this order

| Doc | What it answers |
|---|---|
| [00-CONTEXT-CURRENT-SYSTEM.md](00-CONTEXT-CURRENT-SYSTEM.md) | How the app works **today**, verified against the source. Start here — the target design constantly refers back to it. |
| [01-TARGET-ARCHITECTURE.md](01-TARGET-ARCHITECTURE.md) | The destination. Runtime map, directory layout, and what each of the five services is responsible for. |
| [02-DATA-MODEL.md](02-DATA-MODEL.md) | The Postgres schema — board, auth and chat — with the reasoning behind each constraint and index. |
| [03-REALTIME-SPEC.md](03-REALTIME-SPEC.md) | Pusher channels, the event catalogue, subscription authorization, presence, typing, and the mandatory catch-up path. |
| [04-MIGRATION-PLAN.md](04-MIGRATION-PLAN.md) | 13 phases with exit criteria, plus the 20-line parity checklist that gates cutover. |
| [05-DECISIONS.md](05-DECISIONS.md) | ADRs. What was decided, why, and what it costs. |
| [06-OPEN-QUESTIONS.md](06-OPEN-QUESTIONS.md) | 12 questions with recommendations. **Three are blocking.** Answers get recorded here. |

## Answer these before writing code

| | Question | Blocks |
|---|---|---|
| Q1 | How do health checks reach `*.internal` hosts from a serverless function? | Phase 6 |
| Q3 | Should the IP allowlist fail open or closed on a public URL? | Phase 4 |
| Q4 | Are chat participants auth accounts or board directory people? | Phase 2 — **schema** |

Q1 and Q4 in particular: Q1 is a feature outage rather than a degradation, and Q4 decides foreign keys
that are expensive to change once there is data.

## Two things that are easy to miss

- **This is a rewrite, not a feature.** Chat is roughly the last third of the work. The first two
  thirds is moving an app that assumes a persistent process with local disk onto a platform that has
  neither. See [04](04-MIGRATION-PLAN.md).
- **Pusher does not replay missed events.** Every realtime feature needs the catch-up path in
  [03](03-REALTIME-SPEC.md) §7, wired from the start. Skipping it ships a chat that silently drops
  messages whenever a laptop lid closes.
