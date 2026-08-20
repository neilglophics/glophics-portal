/**
 * Claim mutations, and the per-repo notes.
 *
 * Ported from State.addClaim / forceFreeTicket / forceFreeServer / setRepoNote.
 *
 * The important difference from the legacy version is scope. There, every one of
 * these ended in `POST /api/state` replacing the whole board — last-write-wins,
 * so two people acting at once meant one silently lost their change. Here each
 * function touches only the rows it names, inside a transaction, so concurrent
 * edits to different things cannot collide. See ADR-005.
 */

import { sql, withTransaction } from "@/lib/db/client";
import type { Settings } from "@/lib/types";

/** A plain discriminated union. Callers narrow on `ok` and read `value`. */
export type Result<T = null> = { ok: true; value: T } | { ok: false; errors: string[] };

const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface NewClaim {
  serverId: string;
  repos: string[];
  userIds: string[];
  jiraTicket?: string | null;
  summary?: string | null;
  note?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  jiraStatus?: string | null;
}

/** Ported from State.validateClaim, including the requireTicket setting. */
function validate(input: NewClaim, settings: Settings): string[] {
  const errors: string[] = [];

  if (!input.repos.length) errors.push("Select at least one repo to claim.");
  if (!input.userIds.length) errors.push("At least one user is required.");

  const ticket = input.jiraTicket?.trim();
  if (ticket || settings.jira.requireTicket) {
    if (!ticket || !JIRA_KEY_PATTERN.test(ticket)) {
      errors.push("Jira ticket must look like PROJ-1234.");
    }
  }

  if (!input.startTime || !input.endTime) {
    errors.push("Start and end time are required.");
  } else if (new Date(input.endTime).getTime() <= new Date(input.startTime).getTime()) {
    errors.push("End time must be after start time.");
  }

  return errors;
}

/**
 * Creates a claim on specific repos of one environment.
 *
 * A real ticket key is tagged `source: "jira"` so the sync takes it over from
 * here — refreshing its status and freeing it once the ticket reaches a releasing
 * status. Without one it is a manual claim that only a person can end.
 */
export async function createClaim(input: NewClaim, settings: Settings): Promise<Result<{ id: string }>> {
  const envRows = (await sql`
    SELECT s.id, s.name, a.display_name AS account_name
      FROM servers s JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ${input.serverId}
  `) as { id: string; name: string; account_name: string }[];

  const env = envRows[0];
  if (!env) return { ok: false, errors: ["Environment not found."] };

  // Only repos this environment actually has. A payload naming one it does not
  // is filtered rather than rejected, matching the legacy behaviour.
  const validRepos = (await sql`
    SELECT repo_name FROM server_repos WHERE server_id = ${input.serverId}
  `) as { repo_name: string }[];

  const allowed = new Set(validRepos.map((r) => r.repo_name));
  const repos = input.repos.filter((r) => allowed.has(r));

  const ticket = input.jiraTicket?.trim().toUpperCase() || null;
  const errors = validate({ ...input, repos, jiraTicket: ticket }, settings);
  if (errors.length) return { ok: false, errors };

  const id = ticket ?? `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // One transaction: a claim with no rows in claim_repos holds nothing and
  // would render as a ghost, so the parent and its repos must land together.
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO claims (id, source, server_id, account_name, branch, status,
                             summary, note, start_time, end_time, claimed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          id,
          ticket ? "jira" : "manual",
          input.serverId,
          env.account_name,
          env.name,
          ticket ? (input.jiraStatus ?? "Pending sync") : "Manual",
          input.summary?.trim() || null,
          input.note?.trim() || null,
          input.startTime,
          input.endTime,
        ],
      );

      for (const repo of repos) {
        await client.query("INSERT INTO claim_repos (claim_id, repo_name) VALUES ($1, $2)", [id, repo]);
      }
      for (const userId of input.userIds) {
        await client.query(
          `INSERT INTO claim_assignees (claim_id, directory_user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [id, userId],
        );
      }
    });
  } catch (err) {
    // A duplicate id means this exact Jira key already holds something here.
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, errors: [`${id} is already holding a repository on this board.`] };
    }
    throw err;
  }

  return { ok: true, value: { id } };
}

/**
 * Drops one claim. Its repos and assignees go with it via ON DELETE CASCADE.
 *
 * If the ticket is still at an occupying status the next sync may re-claim it —
 * that is the documented behaviour, not a bug: the board follows Jira.
 */
export async function releaseClaim(claimId: string): Promise<Result> {
  const rows = (await sql`DELETE FROM claims WHERE id = ${claimId} RETURNING id`) as { id: string }[];
  if (!rows.length) return { ok: false, errors: ["That claim no longer exists."] };
  return { ok: true, value: null };
}

/** Drops every claim on one environment. */
export async function releaseServerClaims(serverId: string): Promise<Result<{ released: number }>> {
  const rows = (await sql`
    DELETE FROM claims WHERE server_id = ${serverId} RETURNING id
  `) as { id: string }[];
  return { ok: true, value: { released: rows.length } };
}

/**
 * The free-text note on one repository of one environment.
 *
 * In the legacy board this lived in its own notes.json keyed by the string
 * `serverId::repoName` — which is exactly server_repos' primary key, so the
 * separate store earned nothing. Blank deletes, matching the old behaviour.
 */
export async function setRepoNote(serverId: string, repoName: string, text: string): Promise<Result> {
  const trimmed = text.trim();
  const rows = (await sql`
    UPDATE server_repos SET note = ${trimmed || null}
     WHERE server_id = ${serverId} AND repo_name = ${repoName}
     RETURNING repo_name
  `) as { repo_name: string }[];

  if (!rows.length) return { ok: false, errors: ["That repository is not on this environment."] };
  return { ok: true, value: null };
}

/**
 * Plain time-based expiry. Independent of Jira, applies to every claim with an
 * end time. Only acts when onExpiry is "auto-release" — "remind" and
 * "remind-flag" are display-only and need no server-side action.
 *
 * Called by the expiry cron.
 */
export async function releaseExpiredClaims(settings: Settings): Promise<number> {
  if (settings.onExpiry !== "auto-release") return 0;

  const rows = (await sql`
    DELETE FROM claims
     WHERE end_time IS NOT NULL AND end_time <= now()
     RETURNING id
  `) as { id: string }[];

  return rows.length;
}
