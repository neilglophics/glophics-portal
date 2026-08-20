/**
 * Everything behind the `configure` capability: the people directory, accounts,
 * environments, and settings.
 *
 * Ported from the addUser/updateUser/addAccount/updateAccount/addServer/
 * updateServer family in the legacy public/js/state.js. The validation rules are
 * the same; what changed is that they now run on the server (they only ever ran
 * in the browser before, with the server accepting whatever arrived and stripping
 * fields by role) and that constraints back them up in the database.
 *
 * The ripple rules are the important part to preserve. Editing an account's
 * repository list, or renaming an environment, changes what Jira tickets match —
 * so claims recorded under the old name are rewritten, and repos that no longer
 * exist take their URLs, notes and claims with them.
 */

import { sql, withTransaction } from "@/lib/db/client";
import type { Result } from "./claims";
import type { OnExpiry, Settings } from "@/lib/types";

const slug = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const uniqueTrimmed = (values: string[]) => [
  ...new Set(values.map((v) => v.trim()).filter(Boolean)),
];

// ============================================================
// The people directory
// ============================================================

export interface DirectoryInput {
  name: string;
  jobRole?: string;
  /** "[BE]_Sem, [QA]_Sem" from a text field, or an array. Blank falls back to
   *  the display name, which is what the field did before it existed. */
  jiraNames?: string | string[];
}

function normalizeJiraNames(value: DirectoryInput["jiraNames"], fallbackName: string): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const names = uniqueTrimmed(list.map(String));
  if (names.length) return names;
  const fallback = fallbackName.trim();
  return fallback ? [fallback] : [];
}

async function writeJiraNames(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  personId: string,
  names: string[],
): Promise<void> {
  await client.query("DELETE FROM directory_user_jira_names WHERE directory_user_id = $1", [personId]);
  for (const name of names) {
    await client.query(
      "INSERT INTO directory_user_jira_names (directory_user_id, jira_name) VALUES ($1, $2)",
      [personId, name],
    );
  }
}

/**
 * Two people answering to the same Jira label makes matching a coin toss, so the
 * clash is refused here rather than resolved silently at sync time. The database
 * index enforces it too; this only produces a readable message.
 */
async function jiraNameClashes(names: string[], exceptPersonId: string | null): Promise<string[]> {
  const errors: string[] = [];

  for (const name of names) {
    const rows = (await sql`
      SELECT d.name AS owner_name
        FROM directory_user_jira_names n
        JOIN directory_users d ON d.id = n.directory_user_id
       WHERE lower(btrim(n.jira_name)) = lower(btrim(${name}))
         AND (${exceptPersonId}::text IS NULL OR n.directory_user_id <> ${exceptPersonId})
       LIMIT 1
    `) as { owner_name: string }[];

    const owner = rows[0];
    if (owner) errors.push(`"${name}" is already a Jira name for ${owner.owner_name}.`);
  }
  return errors;
}

export async function createDirectoryPerson(input: DirectoryInput): Promise<Result<{ id: string }>> {
  const name = input.name.trim();
  const names = normalizeJiraNames(input.jiraNames, name);

  const errors: string[] = [];
  if (!name) errors.push("Display name is required.");

  const id = slug(name);
  if (name && !id) errors.push("Display name needs at least one letter or number.");

  if (name) {
    const taken = (await sql`
      SELECT 1 FROM directory_users WHERE lower(btrim(name)) = lower(btrim(${name})) LIMIT 1
    `) as unknown[];
    if (taken.length) errors.push(`Another person is already called "${name}".`);
  }
  errors.push(...(await jiraNameClashes(names, null)));
  if (errors.length) return { ok: false, errors };

  // The slug can collide even when the display name does not ("A/B" and "A-B").
  const finalId = await freeId(id);

  await withTransaction(async (client) => {
    await client.query("INSERT INTO directory_users (id, name, job_role) VALUES ($1, $2, $3)", [
      finalId,
      name,
      input.jobRole?.trim() ?? "",
    ]);
    await writeJiraNames(client, finalId, names);
  });

  return { ok: true, value: { id: finalId } };
}

async function freeId(base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const rows = (await sql`SELECT 1 FROM directory_users WHERE id = ${candidate} LIMIT 1`) as unknown[];
    if (!rows.length) return candidate;
  }
}

/**
 * A person's Jira names are what "Ticket Assignee" labels are matched against,
 * so editing them changes who the next sync resolves a ticket to. Claims
 * reference people by id, so the ones already on the board follow a rename.
 */
export async function updateDirectoryPerson(id: string, input: DirectoryInput): Promise<Result> {
  const exists = (await sql`SELECT 1 FROM directory_users WHERE id = ${id} LIMIT 1`) as unknown[];
  if (!exists.length) return { ok: false, errors: ["That person no longer exists."] };

  const name = input.name.trim();
  const names = normalizeJiraNames(input.jiraNames, name);

  const errors: string[] = [];
  if (!name) errors.push("Display name is required.");

  if (name) {
    const taken = (await sql`
      SELECT 1 FROM directory_users
       WHERE lower(btrim(name)) = lower(btrim(${name})) AND id <> ${id} LIMIT 1
    `) as unknown[];
    if (taken.length) errors.push(`Another person is already called "${name}".`);
  }
  errors.push(...(await jiraNameClashes(names, id)));
  if (errors.length) return { ok: false, errors };

  await withTransaction(async (client) => {
    await client.query("UPDATE directory_users SET name = $2, job_role = $3 WHERE id = $1", [
      id,
      name,
      input.jobRole?.trim() ?? "",
    ]);
    await writeJiraNames(client, id, names);
  });

  return { ok: true, value: null };
}

export async function deleteDirectoryPerson(id: string): Promise<Result> {
  // A person with a login is two records, and removing only the directory half
  // would leave an account pointing at nobody — able to sign in, and shown none
  // of its own tickets. Refuse rather than half-do it.
  const login = (await sql`
    SELECT username FROM auth_users WHERE directory_user_id = ${id} LIMIT 1
  `) as { username: string }[];

  if (login[0]) {
    return {
      ok: false,
      errors: [
        `Remove the login @${login[0].username} first — an account left pointing at nobody can still ` +
          `sign in but is shown none of its own tickets.`,
      ],
    };
  }

  const rows = (await sql`DELETE FROM directory_users WHERE id = ${id} RETURNING id`) as { id: string }[];
  if (!rows.length) return { ok: false, errors: ["That person no longer exists."] };
  return { ok: true, value: null };
}

// ============================================================
// Accounts
// ============================================================

export interface AccountInput {
  displayName: string;
  repositories: string[];
}

export async function createAccount(input: AccountInput): Promise<Result<{ id: string }>> {
  const displayName = input.displayName.trim();
  const repos = uniqueTrimmed(input.repositories);
  const id = slug(displayName);

  const errors: string[] = [];
  if (!displayName) errors.push("Display name is required.");
  // The id is derived, so a blank one only ever means the name had nothing to
  // slug — say that instead of naming a hidden field.
  if (displayName && !id) errors.push("Display name needs at least one letter or number.");
  if (!repos.length) errors.push("At least one repository is required.");

  if (displayName) {
    const taken = (await sql`
      SELECT 1 FROM accounts WHERE lower(btrim(display_name)) = lower(btrim(${displayName})) LIMIT 1
    `) as unknown[];
    if (taken.length) errors.push(`Another account is already called "${displayName}".`);
  }
  if (errors.length) return { ok: false, errors };

  await withTransaction(async (client) => {
    await client.query("INSERT INTO accounts (id, display_name) VALUES ($1, $2)", [id, displayName]);
    for (const [index, repo] of repos.entries()) {
      await client.query(
        "INSERT INTO account_repositories (account_id, repo_name, sort_order) VALUES ($1, $2, $3)",
        [id, repo, index],
      );
    }
  });

  return { ok: true, value: { id } };
}

/**
 * Editing an account ripples outward. Its displayName is what Jira tickets are
 * matched on and what active claims recorded; its repository list defines the
 * per-repo slots every environment under it carries.
 *
 * So: repos added here appear unconfigured on those environments, and repos
 * dropped here take their URLs, notes and claims with them.
 */
export async function updateAccount(id: string, input: AccountInput): Promise<Result> {
  const rows = (await sql`SELECT id FROM accounts WHERE id = ${id}`) as { id: string }[];
  if (!rows.length) return { ok: false, errors: ["Account not found."] };

  const displayName = input.displayName.trim();
  const repos = uniqueTrimmed(input.repositories);

  const errors: string[] = [];
  if (!displayName) errors.push("Display name is required.");
  if (!repos.length) errors.push("At least one repository is required.");

  if (displayName) {
    const taken = (await sql`
      SELECT 1 FROM accounts
       WHERE lower(btrim(display_name)) = lower(btrim(${displayName})) AND id <> ${id} LIMIT 1
    `) as unknown[];
    if (taken.length) errors.push(`Another account is already called "${displayName}".`);
  }
  if (errors.length) return { ok: false, errors };

  await withTransaction(async (client) => {
    await client.query("UPDATE accounts SET display_name = $2 WHERE id = $1", [id, displayName]);

    // Rewrite the repository list.
    await client.query(
      `DELETE FROM account_repositories
        WHERE account_id = $1 AND repo_name <> ALL($2::text[])`,
      [id, repos],
    );
    for (const [index, repo] of repos.entries()) {
      await client.query(
        `INSERT INTO account_repositories (account_id, repo_name, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, repo_name) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [id, repo, index],
      );
    }

    // Repos this account no longer has, gone from every environment under it —
    // taking their URLs, notes, and any claim on them.
    await client.query(
      `DELETE FROM server_repos
        WHERE server_id IN (SELECT id FROM servers WHERE account_id = $1)
          AND repo_name <> ALL($2::text[])`,
      [id, repos],
    );
    await client.query(
      `DELETE FROM claim_repos
        WHERE repo_name <> ALL($2::text[])
          AND claim_id IN (
            SELECT c.id FROM claims c JOIN servers s ON s.id = c.server_id WHERE s.account_id = $1
          )`,
      [id, repos],
    );

    // New repos appear on every environment, unconfigured.
    for (const repo of repos) {
      await client.query(
        `INSERT INTO server_repos (server_id, repo_name, url, health)
         SELECT s.id, $2, '', 'unconfigured' FROM servers s WHERE s.account_id = $1
         ON CONFLICT (server_id, repo_name) DO NOTHING`,
        [id, repo],
      );
    }

    // The denormalised copy on each claim, kept in step with the rename.
    await client.query(
      `UPDATE claims SET account_name = $2
        WHERE server_id IN (SELECT id FROM servers WHERE account_id = $1)`,
      [id, displayName],
    );

    // A claim that held only dropped repos no longer occupies anything.
    await client.query(
      `DELETE FROM claims WHERE id IN (
         SELECT c.id FROM claims c
           JOIN servers s ON s.id = c.server_id
          WHERE s.account_id = $1
            AND NOT EXISTS (SELECT 1 FROM claim_repos cr WHERE cr.claim_id = c.id)
       )`,
      [id],
    );
  });

  return { ok: true, value: null };
}

export async function deleteAccount(id: string): Promise<Result> {
  // ON DELETE RESTRICT on servers.account_id means this fails while any
  // environment still belongs to the account, which is the right answer — but
  // the message needs to say so.
  const owned = (await sql`SELECT count(*)::int AS n FROM servers WHERE account_id = ${id}`) as {
    n: number;
  }[];

  if ((owned[0]?.n ?? 0) > 0) {
    return {
      ok: false,
      errors: [`That account still has ${owned[0]!.n} environment(s). Remove or move them first.`],
    };
  }

  const rows = (await sql`DELETE FROM accounts WHERE id = ${id} RETURNING id`) as { id: string }[];
  if (!rows.length) return { ok: false, errors: ["Account not found."] };
  return { ok: true, value: null };
}

// ============================================================
// Environments
// ============================================================

export interface ServerInput {
  name: string;
  accountId: string;
  /** repoName -> url */
  repoUrls?: Record<string, string>;
}

export async function createServer(input: ServerInput): Promise<Result<{ id: string }>> {
  const name = input.name.trim();

  const accountRows = (await sql`
    SELECT id, display_name FROM accounts WHERE id = ${input.accountId}
  `) as { id: string; display_name: string }[];
  const account = accountRows[0];

  const errors: string[] = [];
  if (!name) errors.push("Environment name is required.");
  if (!account) errors.push("Pick an account for this environment.");

  if (name && account) {
    const clash = (await sql`
      SELECT 1 FROM servers
       WHERE account_id = ${account.id} AND lower(btrim(name)) = lower(btrim(${name})) LIMIT 1
    `) as unknown[];
    if (clash.length) {
      errors.push(`${account.display_name} already has an environment called "${name}".`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const repoNames = (await sql`
    SELECT repo_name FROM account_repositories WHERE account_id = ${account!.id} ORDER BY sort_order
  `) as { repo_name: string }[];

  const id = await freeServerId(slug(name) || "env");

  await withTransaction(async (client) => {
    await client.query("INSERT INTO servers (id, name, account_id) VALUES ($1, $2, $3)", [
      id,
      name,
      account!.id,
    ]);
    for (const { repo_name } of repoNames) {
      const url = (input.repoUrls?.[repo_name] ?? "").trim();
      await client.query(
        "INSERT INTO server_repos (server_id, repo_name, url, health) VALUES ($1, $2, $3, $4)",
        [id, repo_name, url, url ? "checking" : "unconfigured"],
      );
    }
  });

  return { ok: true, value: { id } };
}

async function freeServerId(base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const rows = (await sql`SELECT 1 FROM servers WHERE id = ${candidate} LIMIT 1`) as unknown[];
    if (!rows.length) return candidate;
  }
}

/**
 * An environment's name is the "Branch" Jira matches on, and its account decides
 * which repo slots it carries — so an edit ripples the same way an account edit
 * does: claims recorded under the old name are rewritten, and repos the new
 * account does not have take their URLs, notes and claims with them.
 */
export async function updateServer(id: string, input: ServerInput): Promise<Result> {
  const current = (await sql`SELECT id, account_id FROM servers WHERE id = ${id}`) as {
    id: string;
    account_id: string;
  }[];
  if (!current[0]) return { ok: false, errors: ["Environment not found."] };

  const name = input.name.trim();
  const accountId = input.accountId || current[0].account_id;

  const accountRows = (await sql`
    SELECT id, display_name FROM accounts WHERE id = ${accountId}
  `) as { id: string; display_name: string }[];
  const account = accountRows[0];

  const errors: string[] = [];
  if (!name) errors.push("Environment name is required.");
  if (!account) errors.push("Pick an account for this environment.");

  if (name && account) {
    const clash = (await sql`
      SELECT 1 FROM servers
       WHERE account_id = ${account.id}
         AND lower(btrim(name)) = lower(btrim(${name}))
         AND id <> ${id}
       LIMIT 1
    `) as unknown[];
    if (clash.length) {
      errors.push(`${account.display_name} already has an environment called "${name}".`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const repoRows = (await sql`
    SELECT repo_name FROM account_repositories WHERE account_id = ${account!.id} ORDER BY sort_order
  `) as { repo_name: string }[];
  const repoNames = repoRows.map((r) => r.repo_name);

  await withTransaction(async (client) => {
    await client.query("UPDATE servers SET name = $2, account_id = $3 WHERE id = $1", [
      id,
      name,
      account!.id,
    ]);

    // Repos the new account does not have, gone — with their notes and claims.
    await client.query(
      "DELETE FROM server_repos WHERE server_id = $1 AND repo_name <> ALL($2::text[])",
      [id, repoNames],
    );
    await client.query(
      `DELETE FROM claim_repos
        WHERE repo_name <> ALL($2::text[])
          AND claim_id IN (SELECT id FROM claims WHERE server_id = $1)`,
      [id, repoNames],
    );

    for (const repoName of repoNames) {
      const url = (input.repoUrls?.[repoName] ?? "").trim();
      // An untouched URL keeps the health last measured for it — only a changed
      // one goes back to "checking".
      await client.query(
        `INSERT INTO server_repos (server_id, repo_name, url, health)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (server_id, repo_name) DO UPDATE
           SET url = EXCLUDED.url,
               health = CASE WHEN server_repos.url = EXCLUDED.url
                             THEN server_repos.health ELSE EXCLUDED.health END,
               health_checked_at = CASE WHEN server_repos.url = EXCLUDED.url
                                        THEN server_repos.health_checked_at ELSE NULL END`,
        [id, repoName, url, url ? "checking" : "unconfigured"],
      );
    }

    await client.query(
      "UPDATE claims SET branch = $2, account_name = $3 WHERE server_id = $1",
      [id, name, account!.display_name],
    );

    await client.query(
      `DELETE FROM claims
        WHERE server_id = $1
          AND NOT EXISTS (SELECT 1 FROM claim_repos cr WHERE cr.claim_id = claims.id)`,
      [id],
    );
  });

  return { ok: true, value: null };
}

export async function deleteServer(id: string): Promise<Result> {
  // server_repos and claims cascade on the foreign key, so the notes and claims
  // go with it — which is what the legacy removeServer did by hand.
  const rows = (await sql`DELETE FROM servers WHERE id = ${id} RETURNING id`) as { id: string }[];
  if (!rows.length) return { ok: false, errors: ["Environment not found."] };
  return { ok: true, value: null };
}

// ============================================================
// Settings
// ============================================================

export async function updateSettings(patch: {
  defaultBookingHours?: number;
  onExpiry?: OnExpiry;
  assignWholeEnv?: boolean;
  jira?: Partial<Settings["jira"]>;
}): Promise<Result> {
  const errors: string[] = [];

  if (patch.defaultBookingHours !== undefined) {
    const hours = Number(patch.defaultBookingHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      errors.push("Default booking length must be between 1 and 720 hours.");
    }
  }
  if (patch.onExpiry && !["remind", "remind-flag", "auto-release"].includes(patch.onExpiry)) {
    errors.push("Unknown expiry behaviour.");
  }
  if (errors.length) return { ok: false, errors };

  // The row may not exist yet on a fresh database, hence the upsert. `jira` is
  // merged rather than replaced so a partial patch cannot drop the status lists.
  await sql`
    INSERT INTO settings (id, default_booking_hours, on_expiry, assign_whole_env, jira, updated_at)
    VALUES (
      1,
      COALESCE(${patch.defaultBookingHours ?? null}::int, 4),
      COALESCE(${patch.onExpiry ?? null}::text, 'remind'),
      COALESCE(${patch.assignWholeEnv ?? null}::boolean, true),
      COALESCE(${patch.jira ? JSON.stringify(patch.jira) : null}::jsonb, '{}'::jsonb),
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      default_booking_hours =
        COALESCE(${patch.defaultBookingHours ?? null}::int, settings.default_booking_hours),
      on_expiry = COALESCE(${patch.onExpiry ?? null}::text, settings.on_expiry),
      assign_whole_env =
        COALESCE(${patch.assignWholeEnv ?? null}::boolean, settings.assign_whole_env),
      jira = settings.jira || COALESCE(${patch.jira ? JSON.stringify(patch.jira) : null}::jsonb, '{}'::jsonb),
      updated_at = now()
  `;

  return { ok: true, value: null };
}
