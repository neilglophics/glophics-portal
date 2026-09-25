/**
 * Board reads. The only module that sees snake_case — everything above it uses
 * the camelCase shapes in lib/types.ts.
 *
 * These are called from Server Components, so there is no client-side board
 * fetch, no `appData` blob and no localStorage cache. That deletes an entire
 * class of staleness bug the legacy app had to work around.
 *
 * Aggregation note: rather than N+1 queries per environment, each of these does
 * one query returning the join rows and assembles the nested shape in JS. At
 * this board's size (tens of environments, hundreds of claims) that is cheaper
 * than the round trips, and it keeps the SQL readable.
 */

import { sql } from "@/lib/db/client";
import { withJiraDefaults } from "@/lib/shared/settings";
import type {
  Account,
  Claim,
  DirectoryUser,
  Environment,
  JiraIssue,
  JiraSkipped,
  OnExpiry,
  Settings,
} from "@/lib/types";

// ---------- accounts ----------

export async function getAccounts(): Promise<Account[]> {
  const rows = (await sql`
    SELECT a.id, a.display_name,
           COALESCE(
             array_agg(r.repo_name ORDER BY r.sort_order, r.repo_name)
               FILTER (WHERE r.repo_name IS NOT NULL),
             '{}'
           ) AS repositories
      FROM accounts a
      LEFT JOIN account_repositories r ON r.account_id = a.id
     GROUP BY a.id, a.display_name
     ORDER BY a.display_name
  `) as { id: string; display_name: string; repositories: string[] }[];

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    repositories: r.repositories ?? [],
  }));
}

// ---------- environments ----------

export async function getEnvironments(): Promise<Environment[]> {
  const rows = (await sql`
    SELECT s.id, s.name, s.account_id,
           sr.repo_name, sr.url, sr.health, sr.health_checked_at, sr.note,
           ar.sort_order
      FROM servers s
      LEFT JOIN server_repos sr ON sr.server_id = s.id
      LEFT JOIN account_repositories ar
             ON ar.account_id = s.account_id AND ar.repo_name = sr.repo_name
     ORDER BY s.name, ar.sort_order NULLS LAST, sr.repo_name
  `) as {
    id: string;
    name: string;
    account_id: string;
    repo_name: string | null;
    url: string | null;
    health: string | null;
    health_checked_at: string | null;
    note: string | null;
  }[];

  const byId = new Map<string, Environment>();

  for (const row of rows) {
    let env = byId.get(row.id);
    if (!env) {
      env = { id: row.id, name: row.name, accountId: row.account_id, repos: [] };
      byId.set(row.id, env);
    }
    // A LEFT JOIN with no repos yields one row with nulls — an environment whose
    // account has no repositories configured yet, not a repo named null.
    if (row.repo_name) {
      env.repos.push({
        repoName: row.repo_name,
        url: row.url ?? "",
        health: (row.health ?? "unconfigured") as Environment["repos"][number]["health"],
        healthCheckedAt: row.health_checked_at,
        note: row.note,
      });
    }
  }

  return [...byId.values()];
}

// ---------- claims ----------

/**
 * The claims SELECT's row shape and its mapper, shared by every query that
 * returns claims — the whole list here, and the paged slice in
 * lib/db/queries/tickets.ts. The column list itself cannot be shared: the
 * tagged template parameterises `${}`, so a fragment interpolated into one
 * would arrive as a bind value rather than as SQL. Sharing the mapper is what
 * matters — that is where the snake_case boundary is crossed.
 */
export interface ClaimRow {
  id: string;
  source: "jira" | "manual";
  server_id: string;
  account_name: string | null;
  branch: string | null;
  status: string;
  summary: string | null;
  note: string | null;
  start_time: string | null;
  end_time: string | null;
  claimed_at: string;
  last_synced_at: string | null;
  jira_created_at: string | null;
  jira_updated_at: string | null;
  repos: string[];
  user_ids: string[];
  raw_assignees: string[];
}

export function toClaim(r: ClaimRow): Claim {
  return {
    id: r.id,
    source: r.source,
    serverId: r.server_id,
    accountName: r.account_name,
    branch: r.branch,
    repos: r.repos ?? [],
    userIds: r.user_ids ?? [],
    rawAssignees: r.raw_assignees ?? [],
    status: r.status,
    summary: r.summary,
    note: r.note,
    startTime: r.start_time,
    endTime: r.end_time,
    claimedAt: r.claimed_at,
    lastSyncedAt: r.last_synced_at,
    jiraCreatedAt: r.jira_created_at,
    jiraUpdatedAt: r.jira_updated_at,
  };
}

export async function getClaims(): Promise<Claim[]> {
  const rows = (await sql`
    SELECT c.id, c.source, c.server_id, c.account_name, c.branch, c.status,
           c.summary, c.note, c.start_time, c.end_time, c.claimed_at, c.last_synced_at,
           c.jira_created_at, c.jira_updated_at,
           COALESCE(
             (SELECT array_agg(cr.repo_name ORDER BY cr.repo_name)
                FROM claim_repos cr WHERE cr.claim_id = c.id), '{}'
           ) AS repos,
           COALESCE(
             (SELECT array_agg(ca.directory_user_id ORDER BY ca.directory_user_id)
                FROM claim_assignees ca WHERE ca.claim_id = c.id), '{}'
           ) AS user_ids,
           COALESCE(
             (SELECT array_agg(ra.label ORDER BY ra.label)
                FROM claim_raw_assignees ra WHERE ra.claim_id = c.id), '{}'
           ) AS raw_assignees
      FROM claims c
     ORDER BY c.claimed_at DESC
  `) as ClaimRow[];

  return rows.map(toClaim);
}

// ---------- the people directory ----------

export async function getDirectoryUsers(): Promise<DirectoryUser[]> {
  const rows = (await sql`
    SELECT d.id, d.name, d.job_role, u.id AS avatar_user_id,
           COALESCE(
             array_agg(n.jira_name ORDER BY n.jira_name)
               FILTER (WHERE n.jira_name IS NOT NULL),
             '{}'
           ) AS jira_names
      FROM directory_users d
      LEFT JOIN directory_user_jira_names n ON n.directory_user_id = d.id
      LEFT JOIN auth_users u ON u.directory_user_id = d.id AND u.active = true
     GROUP BY d.id, d.name, d.job_role, u.id
     ORDER BY d.name
  `) as {
    id: string;
    name: string;
    job_role: string;
    jira_names: string[];
    avatar_user_id: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    jobRole: r.job_role,
    jiraNames: r.jira_names ?? [],
    avatarUserId: r.avatar_user_id,
  }));
}

// ---------- settings ----------

export async function getSettings(): Promise<Settings> {
  const rows = (await sql`
    SELECT default_booking_hours, on_expiry, assign_whole_env, jira
      FROM settings WHERE id = 1
  `) as {
    default_booking_hours: number;
    on_expiry: OnExpiry;
    assign_whole_env: boolean;
    jira: unknown;
  }[];

  const row = rows[0];
  // No row yet is the ordinary first-run path, not a fault: the defaults are the
  // answer until somebody saves something.
  if (!row) {
    const { DEFAULT_SETTINGS } = await import("@/lib/shared/settings");
    return DEFAULT_SETTINGS;
  }

  return {
    defaultBookingHours: row.default_booking_hours,
    onExpiry: row.on_expiry,
    assignWholeEnv: row.assign_whole_env,
    jira: withJiraDefaults(row.jira),
  };
}

// ---------- the Jira-derived cache ----------

/** The jira_issues SELECT's row shape and mapper. Shared for the same reason
 *  ClaimRow/toClaim are — see the note there. */
export interface JiraIssueRow {
  key: string;
  server_id: string | null;
  account_name: string | null;
  branch: string | null;
  status: string | null;
  summary: string | null;
  start_time: string | null;
  end_time: string | null;
  repos: string[];
  user_ids: string[];
  raw_assignees: string[];
  jira_created_at: string | null;
  jira_updated_at: string | null;
}

export function toJiraIssue(r: JiraIssueRow): JiraIssue {
  return {
    key: r.key,
    serverId: r.server_id,
    accountName: r.account_name,
    branch: r.branch,
    repos: r.repos ?? [],
    userIds: r.user_ids ?? [],
    rawAssignees: r.raw_assignees ?? [],
    status: r.status ?? "Unknown",
    summary: r.summary,
    startTime: r.start_time,
    endTime: r.end_time,
    jiraCreatedAt: r.jira_created_at,
    jiraUpdatedAt: r.jira_updated_at,
  };
}

export async function getJiraIssues(): Promise<JiraIssue[]> {
  const rows = (await sql`
    SELECT key, server_id, account_name, branch, status, summary,
           start_time, end_time, repos, user_ids, raw_assignees,
           jira_created_at, jira_updated_at
      FROM jira_issues
     ORDER BY key
  `) as JiraIssueRow[];

  return rows.map(toJiraIssue);
}

/**
 * The Not-tracked list, with each ticket's title and assignees.
 *
 * `jira_skipped` stores only what the page needs to explain the skip. The rest
 * comes from `jira_issues` — and it is always there to join to, because the
 * sync calls `record()` on every ticket it skips (see lib/jira/sync.ts): a
 * skipped ticket is by definition not a claim, so it lands in the cache like
 * any other unclaimed issue. LEFT JOIN rather than JOIN anyway, so a row written
 * by an older sync, before that held, still shows with its reason.
 */
export async function getJiraSkipped(): Promise<JiraSkipped[]> {
  const rows = (await sql`
    SELECT s.key, s.reason, s.status, s.account_name, s.branch,
           i.summary, COALESCE(i.user_ids, '{}') AS user_ids,
           COALESCE(i.raw_assignees, '{}') AS raw_assignees,
           i.jira_updated_at
      FROM jira_skipped s
      LEFT JOIN jira_issues i ON i.key = s.key
     ORDER BY s.key
  `) as {
    key: string;
    reason: string;
    status: string | null;
    account_name: string | null;
    branch: string | null;
    summary: string | null;
    user_ids: string[];
    raw_assignees: string[];
    jira_updated_at: string | null;
  }[];

  return rows.map((r) => ({
    key: r.key,
    reason: r.reason,
    status: r.status,
    accountName: r.account_name,
    branch: r.branch,
    summary: r.summary,
    userIds: r.user_ids,
    rawAssignees: r.raw_assignees,
    jiraUpdatedAt: r.jira_updated_at,
  }));
}

/** Just the count, for the sidebar badge — the Not-tracked page loads the rows. */
export async function getJiraSkippedCount(): Promise<number> {
  const rows = (await sql`SELECT count(*)::int AS n FROM jira_skipped`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function getJiraSyncState(): Promise<{ lastSyncAt: string | null; lastError: string | null }> {
  const rows = (await sql`
    SELECT last_sync_at, last_error FROM jira_sync_state WHERE id = 1
  `) as { last_sync_at: string | null; last_error: string | null }[];

  const row = rows[0];
  return { lastSyncAt: row?.last_sync_at ?? null, lastError: row?.last_error ?? null };
}

// ---------- the whole board ----------

export interface Board {
  accounts: Account[];
  environments: Environment[];
  claims: Claim[];
  directory: DirectoryUser[];
  settings: Settings;
}

/**
 * Everything the shell and most pages need, in parallel.
 *
 * Deliberately does NOT include the Jira-derived cache: it is by far the largest
 * part and only three pages read it. The legacy app shipped the whole thing to
 * every tab on every change, which is most of why its payloads were so big.
 */
export async function getBoard(): Promise<Board> {
  const [accounts, environments, claims, directory, settings] = await Promise.all([
    getAccounts(),
    getEnvironments(),
    getClaims(),
    getDirectoryUsers(),
    getSettings(),
  ]);
  return { accounts, environments, claims, directory, settings };
}
