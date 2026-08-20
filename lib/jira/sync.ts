/**
 * The bulk Jira sync. Ported from server/jobs/sync.js.
 *
 * Instead of looking up one ticket at a time, this pulls every ticket Jira has
 * touched recently in one search and derives each environment's occupancy from
 * the results — no manual "book this ticket" step.
 *
 * The two rules that are easy to lose in a port, and must not be:
 *
 *   1. CLAIMS ARE STICKY. A ticket claims its matched repos the moment its status
 *      first enters occupyingStatuses, and releases them the moment it enters
 *      releasingStatuses — or the moment it is closed, cancelled or done, which
 *      frees the environment whatever the lists say. Any *other* status leaves an
 *      already-active claim untouched. QA FAILED does not free the environment:
 *      the ticket bounced back, it is still being worked.
 *
 *   2. HELD KEYS ARE ALWAYS RE-FETCHED BY NAME. DONE is both a releasing status
 *      and one nobody wants pulled in bulk. Without the `OR key IN (…)` clause
 *      the sync would stop seeing held tickets, and an environment would stay
 *      held forever with no way for Jira to say otherwise.
 *
 * The search window (`updated >= -30d`) is a practical bound, not a guarantee: a
 * claim still open but untouched in Jira for 30+ days will not be re-confirmed,
 * but it will not be silently dropped either — it stays claimed until the ticket
 * is updated again or somebody forces it free.
 */

import { sql, withTransaction } from "@/lib/db/client";
import {
  AUTOFILL_FIELD_NAMES,
  asStringArray,
  authHeader,
  firstOf,
  loadFieldIdMap,
  loadJiraConfig,
  normalizeBaseUrl,
  pickFieldValue,
  type JiraConfig,
} from "./client";
import {
  findServerForTicket,
  matchRepositoriesToKeys,
  matchUserIdsByLabels,
  statusFrees,
  statusIn,
  statusIsTerminal,
} from "./matching";
import { getAccounts, getDirectoryUsers, getEnvironments, getSettings } from "@/lib/db/queries/board";
import type { Account, DirectoryUser, Environment, Settings } from "@/lib/types";

const SYNC_WINDOW = "updated >= -30d";
const PAGE_SIZE = 100;
/** Bounds one sync at 500 issues so a large backlog cannot stall the pass — and,
 *  on Vercel, cannot run past the function timeout. */
const MAX_PAGES = 5;

/** A JQL string literal. Status names carry spaces and brackets, so they are
 *  always quoted; a stray quote or backslash is escaped rather than left to
 *  break the query. */
const jqlText = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Issue keys go in unquoted, and only if they look like keys — the list is
 *  built from stored claims, and anything that is not a real key would only be a
 *  way to break the query. */
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

interface TicketFields {
  key: string;
  summary: string;
  status: string;
  ticketAssignees: string[];
  accountName: string | null;
  branch: string | null;
  repository: string[];
  startDate: string | null;
  dueDate: string | null;
}

function buildJql(settings: Settings, heldKeys: string[]): string {
  const ignored = settings.jira.ignoredStatuses.filter(Boolean);
  const window = ignored.length
    ? `(${SYNC_WINDOW} AND status NOT IN (${ignored.map(jqlText).join(", ")}))`
    : SYNC_WINDOW;

  const where = heldKeys.length ? `${window} OR key IN (${heldKeys.join(", ")})` : window;
  return `${where} ORDER BY updated DESC`;
}

/**
 * Uses /rest/api/3/search/jql. The old /rest/api/3/search was removed by
 * Atlassian and answers 410. The replacement pages with an opaque nextPageToken
 * cursor rather than startAt, and reports the end with isLast.
 */
async function fetchIssues(
  config: JiraConfig,
  fieldIds: Set<string>,
  query: string,
): Promise<{ key: string; fields: Record<string, unknown> }[]> {
  const jql = encodeURIComponent(query);
  const fields = encodeURIComponent([...fieldIds].join(","));
  const base = normalizeBaseUrl(config.baseUrl);

  const issues: { key: string; fields: Record<string, unknown> }[] = [];
  let token: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const cursor = token ? `&nextPageToken=${encodeURIComponent(token)}` : "";
    const url = `${base}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=${PAGE_SIZE}${cursor}`;

    const response = await fetch(url, {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Jira search returned ${response.status}`);

    const data = (await response.json()) as {
      issues?: { key: string; fields: Record<string, unknown> }[];
      nextPageToken?: string;
      isLast?: boolean;
    };

    issues.push(...(data.issues ?? []));
    token = data.nextPageToken;
    if (data.isLast || !token) break;
  }

  return issues;
}

function extractFields(
  issue: { key: string; fields: Record<string, unknown> },
  fieldMap: Record<string, string[]>,
): TicketFields {
  const f = issue.fields as Record<string, unknown> & {
    summary?: string;
    status?: { name?: string };
  };

  return {
    key: issue.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "Unknown",
    ticketAssignees: asStringArray(pickFieldValue(f, fieldMap["ticket assignee"])),
    accountName: firstOf(pickFieldValue(f, fieldMap["account name"])),
    branch: firstOf(pickFieldValue(f, fieldMap["branch"])),
    repository: asStringArray(pickFieldValue(f, fieldMap["repository"])),
    startDate: firstOf(pickFieldValue(f, fieldMap["start date"])),
    dueDate: firstOf(pickFieldValue(f, fieldMap["due date"])),
  };
}

/** Jira gives dates, not instants. The legacy app pinned them to 09:00 and
 *  18:00 local, which is what "a day's booking" meant on this board. */
const startInstant = (date: string | null) =>
  date ? new Date(`${date}T09:00`).toISOString() : null;
const endInstant = (date: string | null) => (date ? new Date(`${date}T18:00`).toISOString() : null);

export interface SyncResult {
  ok: boolean;
  reason?: "disabled" | "auto-sync-off" | "not-configured" | "error";
  error?: string;
  issueCount?: number;
  claimed?: number;
  released?: number;
  skippedCount?: number;
}

export async function runJiraSync(force: boolean): Promise<SyncResult> {
  const settings = await getSettings();
  if (!settings.jira.enabled) return { ok: false, reason: "disabled" };
  if (!force && !settings.jira.autoSync) return { ok: false, reason: "auto-sync-off" };

  const config = loadJiraConfig();
  if (!config) return { ok: false, reason: "not-configured" };

  const [accounts, environments, directory] = await Promise.all([
    getAccounts(),
    getEnvironments(),
    getDirectoryUsers(),
  ]);

  // Keys currently holding repositories, asked for by name whatever their status.
  const heldRows = (await sql`
    SELECT id FROM claims WHERE source = 'jira'
  `) as { id: string }[];
  const heldKeys = heldRows.map((r) => r.id).filter((id) => JIRA_KEY.test(id));

  try {
    const fieldMap = await loadFieldIdMap(config);
    const fieldIds = new Set(["summary", "status"]);
    for (const name of AUTOFILL_FIELD_NAMES) {
      for (const id of fieldMap[name] ?? []) fieldIds.add(id);
    }

    const raw = await fetchIssues(config, fieldIds, buildJql(settings, heldKeys));
    const tickets = raw.map((issue) => extractFields(issue, fieldMap));

    const outcome = await applySync(tickets, { settings, accounts, environments, directory, heldKeys });

    await sql`
      INSERT INTO jira_sync_state (id, last_sync_at, last_error) VALUES (1, now(), NULL)
      ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), last_error = NULL
    `;

    return { ok: true, issueCount: tickets.length, ...outcome };
  } catch (err) {
    const message = (err as Error).message || "Jira sync failed.";
    await sql`
      INSERT INTO jira_sync_state (id, last_sync_at, last_error) VALUES (1, NULL, ${message})
      ON CONFLICT (id) DO UPDATE SET last_error = ${message}
    `;
    return { ok: false, reason: "error", error: message };
  }
}

interface SyncContext {
  settings: Settings;
  accounts: Account[];
  environments: Environment[];
  directory: DirectoryUser[];
  heldKeys: string[];
}

/**
 * Applies one pass. Everything lands in a single transaction, so a pass that
 * fails part-way leaves the previous board rather than a half-synced one.
 */
async function applySync(
  tickets: TicketFields[],
  ctx: SyncContext,
): Promise<{ claimed: number; released: number; skippedCount: number }> {
  const { settings, accounts, environments, directory } = ctx;
  const held = new Set(ctx.heldKeys);

  interface Skipped {
    key: string;
    reason: string;
    status: string;
    accountName: string | null;
    branch: string | null;
  }
  interface OnBoard {
    key: string;
    serverId: string | null;
    accountName: string | null;
    branch: string | null;
    status: string;
    summary: string;
    startTime: string | null;
    endTime: string | null;
    repos: string[];
    userIds: string[];
    rawAssignees: string[];
  }

  const skipped: Skipped[] = [];
  const onBoard: OnBoard[] = [];
  const toClaim: (OnBoard & { repos: string[] })[] = [];
  const toRelease: string[] = [];
  const toRefresh: { key: string; status: string; summary: string }[] = [];

  /**
   * Everything the sync saw that is not an active claim, in the shape the ticket
   * tables read. A ticket holds repositories only at an occupying status, but it
   * is somebody's ticket at every status — so this keeps the assignees, dates and
   * matched environment rather than a bare count.
   */
  const record = (t: TicketFields) => {
    const match = findServerForTicket(t, accounts, environments);
    const server = "server" in match ? match.server : null;
    const repos = server
      ? matchRepositoriesToKeys(t.repository, server.repos.map((r) => r.repoName)).matched
      : [];

    onBoard.push({
      key: t.key,
      serverId: server?.id ?? null,
      accountName: t.accountName,
      branch: t.branch,
      status: t.status,
      summary: t.summary,
      // Dates as Jira has them. Nothing is being held, so unlike a claim there
      // is no "it started now" to fall back on.
      startTime: startInstant(t.startDate),
      endTime: endInstant(t.dueDate),
      repos,
      userIds: matchUserIdsByLabels(t.ticketAssignees, directory).matched,
      rawAssignees: t.ticketAssignees,
    });
  };

  for (const t of tickets) {
    // Pulled by key, or newly at a status nobody wants listed. Either way it is
    // not carried — that is what "never fetched" means.
    const ignored = statusIn(settings.jira.ignoredStatuses, t.status);

    if (held.has(t.key)) {
      if (!statusFrees(settings.jira, t.status)) {
        // Sticky: repos/serverId/userIds do not move mid-claim — only the
        // display-facing fields refresh each pass.
        toRefresh.push({ key: t.key, status: t.status, summary: t.summary });
        continue;
      }
      // Released: it stops holding repositories. It stays in the tables at its
      // new status unless that status is one we do not carry.
      toRelease.push(t.key);
      if (!ignored) record(t);
      continue;
    }

    if (ignored) continue;

    // A ticket that is finished or cancelled takes no environment, even if
    // somebody has ticked its status as occupying — without this it would claim
    // on one pass and be freed on the next, forever.
    if (statusIsTerminal(t.status) || !statusIn(settings.jira.occupyingStatuses, t.status)) {
      record(t);
      continue;
    }

    const match = findServerForTicket(t, accounts, environments);
    if ("error" in match) {
      skipped.push({
        key: t.key,
        reason: match.error,
        status: t.status,
        accountName: t.accountName,
        branch: t.branch,
      });
      record(t);
      continue;
    }

    if (!t.repository.length) {
      skipped.push({
        key: t.key,
        reason: "Repository field is empty.",
        status: t.status,
        accountName: t.accountName,
        branch: t.branch,
      });
      record(t);
      continue;
    }

    const repoCheck = matchRepositoriesToKeys(
      t.repository,
      match.server.repos.map((r) => r.repoName),
    );
    if (!repoCheck.matched.length) {
      skipped.push({
        key: t.key,
        reason: `Repository field ("${t.repository.join(", ")}") doesn't match any repo on ${match.server.name}.`,
        status: t.status,
        accountName: t.accountName,
        branch: t.branch,
      });
      record(t);
      continue;
    }

    toClaim.push({
      key: t.key,
      serverId: match.server.id,
      accountName: t.accountName,
      branch: t.branch,
      status: t.status,
      summary: t.summary,
      // A claim with no start date started now — it is holding something as of
      // this pass, which is not the same as having no time at all.
      startTime: startInstant(t.startDate) ?? new Date().toISOString(),
      endTime: endInstant(t.dueDate),
      repos: repoCheck.matched,
      userIds: matchUserIdsByLabels(t.ticketAssignees, directory).matched,
      rawAssignees: t.ticketAssignees,
    });
  }

  await withTransaction(async (client) => {
    for (const { key, status, summary } of toRefresh) {
      await client.query(
        "UPDATE claims SET status = $2, summary = $3, last_synced_at = now() WHERE id = $1",
        [key, status, summary],
      );
    }

    if (toRelease.length) {
      await client.query("DELETE FROM claims WHERE id = ANY($1::text[])", [toRelease]);
    }

    for (const claim of toClaim) {
      await client.query(
        `INSERT INTO claims (id, source, server_id, account_name, branch, status, summary,
                             start_time, end_time, claimed_at, last_synced_at)
         VALUES ($1, 'jira', $2, $3, $4, $5, $6, $7, $8, now(), now())
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status, summary = EXCLUDED.summary, last_synced_at = now()`,
        [
          claim.key,
          claim.serverId,
          claim.accountName,
          claim.branch,
          claim.status,
          claim.summary,
          claim.startTime,
          claim.endTime,
        ],
      );

      for (const repo of claim.repos) {
        await client.query(
          "INSERT INTO claim_repos (claim_id, repo_name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [claim.key, repo],
        );
      }
      for (const userId of claim.userIds) {
        await client.query(
          `INSERT INTO claim_assignees (claim_id, directory_user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [claim.key, userId],
        );
      }
      for (const label of claim.rawAssignees) {
        await client.query(
          "INSERT INTO claim_raw_assignees (claim_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [claim.key, label],
        );
      }
    }

    // The derived cache is rebuilt from scratch every pass, exactly as the
    // legacy in-memory version was. It is not a source of truth (ADR-010).
    await client.query("TRUNCATE jira_issues");
    await client.query("TRUNCATE jira_skipped");

    for (const row of onBoard) {
      await client.query(
        `INSERT INTO jira_issues (key, server_id, account_name, branch, status, summary,
                                  start_time, end_time, repos, user_ids, raw_assignees, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11::text[], now())
         ON CONFLICT (key) DO NOTHING`,
        [
          row.key,
          row.serverId,
          row.accountName,
          row.branch,
          row.status,
          row.summary,
          row.startTime,
          row.endTime,
          row.repos,
          row.userIds,
          row.rawAssignees,
        ],
      );
    }

    for (const row of skipped) {
      await client.query(
        `INSERT INTO jira_skipped (key, reason, status, account_name, branch, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (key) DO NOTHING`,
        [row.key, row.reason, row.status, row.accountName, row.branch],
      );
    }
  });

  return { claimed: toClaim.length, released: toRelease.length, skippedCount: skipped.length };
}
