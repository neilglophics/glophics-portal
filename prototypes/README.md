# Prototypes

Design explorations. Nothing here is wired to the app — no `State`, no
`/api/*`, no Jira. Every page renders from the `DATA` block at the bottom of
the file, so a layout can be judged without waiting on real data.

## app-tailwind.html

A soft-lavender SaaS treatment of the whole app: floating rounded shell,
accounts as permanent sidebar navigation, and a table-first page for each
thing you actually need to look at.

```bash
node server.js
# → http://localhost:4000/prototypes/app-tailwind.html
```

Opening the file directly works too — it needs no server. Navigation is
hash-based, so every page is linkable: `…/app-tailwind.html#health`.

| Page | Hash | What it answers |
| --- | --- | --- |
| Dashboard | `#dashboard` | What's the state of the pool right now? |
| Environments | `#environments` | All 14 environments, their repos, who holds them |
| Server health | `#health` | Is every endpoint reachable? Failures sort first |
| In use | `#in-use` | Which repositories are held, and when do they free up? |
| Tickets | `#tickets` | Which Jira tickets are occupying something |
| Not tracked | `#not-tracked` | Tickets in QA testing that matched nothing, and why |
| Settings | `#settings` | Jira connection, status rules, booking rules, directories |

### Notes on the page designs

**Health sorts problems first.** Offline endpoints, then unconfigured ones,
then the rest. A health page whose two failures sit eighteen rows down is
not doing its job, so the sort is part of the design, not a preference.

**In use sorts by urgency** — soonest to free at the top, since the question
being asked is almost always "when can I have one?".

**Not tracked earns a full page.** In the current app this is a cramped
panel in the sync bar, but each row carries a distinct reason and a distinct
fix, and mixing "unknown account" with "empty Repository field" hides that.
The `FIX` column names where to go: unknown account and unknown branch are
settings problems, an incomplete ticket is a Jira problem.

**Repository state is one strip.** SF / API / ADM colored green (free),
amber (held), red (offline), grey (no URL). It replaces the current text
summary, and appears identically on the dashboard cards and the
environments table so it reads the same everywhere.

### Porting this to the real app

The `DATA` block mirrors the real shapes, so the views map field-for-field:

| Prototype | Real app |
| --- | --- |
| `CLAIMS` | `State.getServerTickets(id)` across all servers |
| `SKIPPED` | `State.getSkippedTickets()` |
| `ACCOUNTS` / `envs` | `State.getAccounts()` / `State.getServers()` |
| `envState()` | `State.getDisplayStatus(server)` |
| `repoHealth()` | `server.repos[name].health` |
| `fmtMins()` | `Format.remaining(endTime)` |

The derived helpers were written to match the app's existing semantics —
offline outranks everything, all repos held is `inuse`, some held is
`partial` — so the logic does not need rethinking, only rewiring.

## About the Tailwind setup

This file loads the **Tailwind v4 browser build** from a CDN, which compiles
the classes in the page at load, including ones injected by JS after render.
That keeps the prototype a single file with no toolchain, matching how the
rest of this project works.

Do not ship it that way. The browser build downloads the compiler on every
page load, flashes unstyled content before it finishes, and needs a network
round-trip to a third party. For production, compile ahead of time:

```bash
npm install -D tailwindcss @tailwindcss/cli
npx @tailwindcss/cli -i css/tailwind.src.css -o css/tailwind.css --minify
```

Then replace the CDN `<script>` and the inline `@theme` block with a single
`<link rel="stylesheet" href="css/tailwind.css">`, and move `@theme` into
`css/tailwind.src.css`.

**The decision that actually matters:** that command is a build step, and
this project deliberately has none — `server.js` serves the files on disk
exactly as they are, so `git pull && node server.js` is the whole setup.
Adopting Tailwind properly means a `package.json`, a `node_modules/`, and a
watch process during development, plus remembering to rebuild before
committing. That is a normal trade, but it is a real one, and worth making
deliberately rather than inheriting it from a prototype.

If you want the look without the toolchain, the same design can be written
against the existing `css/style.css` token system — the palette, radii and
shadows here are all expressible as plain CSS custom properties.

## Fonts

Uses **Plus Jakarta Sans** from Google Fonts, not the app's IBM Plex Sans.
The rounded, geometric feel is a large part of why the reference design
reads the way it does. Switching the app's typeface is its own decision,
independent of the layout.
