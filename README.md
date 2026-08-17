# Server Management

Tracks which QA/staging environments are free and which are held by a Jira
ticket, so nobody has to ask in chat before deploying.

Each **account** (client) owns a set of **environments** (`hotfix-1`,
`static-2`, …), and each environment has three **repositories** —
storefront, backend, admin. A ticket claims one or more repositories of one
environment, so an environment can be *partly free*: backend taken, admin
still bookable.

## Running it

Requires Node 18+ (uses built-in `fetch`). No build step, no dependencies.

```bash
node server.js
# → http://localhost:4000
```

State lives in `shared-state.json` next to `server.js` and is pushed to every
open tab over Server-Sent Events, so bookings appear live for everyone
pointed at the same server. Opening `index.html` directly as a file also
works — it falls back to per-browser `localStorage` with no sync.

## Connecting Jira

```bash
cp jira-config.example.json jira-config.json
```

Fill in your site, the account email, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens),
then turn on **Enable Jira** in Settings. `jira-config.json` is gitignored.

Tickets are matched to an environment by **Account Name + Branch +
Repository**, all three of which must be filled in on the ticket. Anything
that can't be matched is listed in the "not tracked" panel on the dashboard
with the reason, so a mis-filled ticket is visible rather than silently
missing.

### How a ticket takes and releases a server

Configured under Settings → Status rules:

- **Occupies a server** — reaching one of these statuses claims the ticket's
  repositories (default: `QA TESTING (DEV)`, `QA TESTING (STG)`).
- **Frees the server** — reaching one of these releases them (default:
  `FINAL CHECKING`, `DONE`).
- Any *other* status leaves an existing claim untouched. `QA FAILED` is
  still being worked on, so it keeps the environment.

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Static file server, shared state, SSE broadcast, Jira polling |
| `js/data.js` | Seed data, migrations, ticket→environment matching (shared with `server.js` via `require`) |
| `js/state.js` | Every read/write of app data; components never touch storage directly |
| `js/storage.js` | The only persistence seam — server when available, `localStorage` otherwise |
| `js/components/` | One file per UI block, each owning its own render + events |
| `css/style.css` | Single stylesheet, design tokens in `:root` |

Occupancy is always **derived** from the active claim list, never stored on
the server record — which is what lets two tickets share one environment and
report "partly free" correctly.
