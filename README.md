# Server Management

Tracks which QA/staging environments are free and which are held by a Jira
ticket, so nobody has to ask in chat before deploying.

Each **account** (client) owns a set of **environments** (`hotfix-1`,
`static-2`, …), and each environment has **repositories** — storefront,
backend, admin. A ticket claims one or more repositories of one environment,
so an environment can be *partly free*: backend taken, admin still bookable.

## Running it

Requires Node 18+ (uses built-in `fetch`). No build step, no dependencies.

```bash
node server.js
# → http://localhost:4000
```

State lives in `shared-state.json` beside `server.js` and is pushed to every
open tab over Server-Sent Events, so a booking appears live for everyone
pointed at the same server. Opening `index.html` directly as a file also
works — it falls back to per-browser `localStorage` with no sync.

For deploying, see [DEPLOY.md](DEPLOY.md). Short version: it needs a host
that runs a persistent process (Render, Railway, Fly, a VPS), not a
serverless one.

## Connecting Jira

```bash
cp jira-config.example.json jira-config.json
```

Fill in your site, the account email, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens),
then turn on **Enable Jira** in Settings. `jira-config.json` is gitignored;
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
index.html          shell markup + script order
js/
  data.js           seed data, migrations, ticket→environment matching
  storage.js        persistence: server + SSE, localStorage fallback
  state.js          the single source of truth; every read and write
  format.js         dates, durations, escaping
  ui/
    tokens.js       every colour, label and icon
    model.js        view-models derived from State
    html.js         presentational primitives (tables, chips, buttons…)
    router.js       hash routing + input-preserving re-render
    actions.js      one delegated listener, `data-action` dispatch
    modals.js       assign / confirm / note dialogs
    shell.js        sidebar, account list, sync indicator
    page-*.js       one file per page
  app.js            boot: wires State changes to Router.render()
server.js           static files, shared state, SSE, Jira + health polling
```

**Data layer.** `js/state.js` is the only thing that touches app data.
Components never call `Storage` and never mutate `appData`; they call
`State.*` and subscribe to `State.subscribe()`. `js/data.js` is shared with
`server.js` via `module.exports`, so browser and server apply identical seed
and migration rules to the same shape.

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
  `runJiraSync()` in `server.js` — the client only reads the result.
- **Tailwind comes from a CDN.** The v4 browser build compiles in the page,
  including classes injected after load. That keeps the no-build-step
  property, but it is not a production setup — see the notes in
  [DEPLOY.md](DEPLOY.md) before shipping it publicly.
