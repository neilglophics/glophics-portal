/**
 * Talking to Jira. Credentials, URLs, and the field-id lookup.
 *
 * Ported from server/jira-client.js, with one structural change: the config comes
 * from environment variables only. The legacy version read config/jira-config.json
 * fresh on every call so a hand-edit applied without a restart — there is no
 * writable disk here, and no process to restart.
 *
 * The token is never part of any response. The settings page shows the fields
 * read-only, which is what the legacy README already described for deployments.
 */

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Accepts a base URL with or without a protocol — people paste bare domains like
 * "company.atlassian.net", and fetch() throws on a protocol-less URL, which
 * surfaces as a confusing "couldn't reach" error.
 */
export function normalizeBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function loadJiraConfig(): JiraConfig | null {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const email = process.env.JIRA_EMAIL?.trim();
  const apiToken = process.env.JIRA_API_TOKEN?.trim();

  if (!baseUrl || !email || !apiToken) return null;
  return { baseUrl, email, apiToken };
}

/** What the settings page may know: whether it is configured, and where from.
 *  Never the token. */
export function describeJiraConfig(): { configured: boolean; baseUrl: string | null; email: string | null } {
  const config = loadJiraConfig();
  return {
    configured: !!config,
    baseUrl: config?.baseUrl ?? null,
    email: config?.email ?? null,
  };
}

export function authHeader(config: JiraConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
}

export const issueUrl = (base: string, key: string) =>
  `${normalizeBaseUrl(base)}/browse/${encodeURIComponent(key)}`;

const commentPath = (base: string, key: string) =>
  `${normalizeBaseUrl(base)}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;

/** The custom fields the sync reads, by their human names. Ids are discovered
 *  at runtime because they differ per Jira site. */
export const AUTOFILL_FIELD_NAMES = [
  "ticket assignee",
  "account name",
  "branch",
  "repository",
  "start date",
  "due date",
] as const;

/**
 * Maps field name -> candidate field ids.
 *
 * Cached in module scope with a TTL, exactly as the legacy version did. The
 * caveat on a serverless platform is that "module scope" lives only as long as a
 * warm instance, so a cold start pays one extra request. That is cheap and the
 * alternative — caching it in Postgres — would need invalidating when somebody
 * adds a field in Jira.
 */
let fieldCache: { map: Record<string, string[]>; at: number } | null = null;
const FIELD_CACHE_TTL_MS = 10 * 60 * 1000;

export async function loadFieldIdMap(config: JiraConfig): Promise<Record<string, string[]>> {
  if (fieldCache && Date.now() - fieldCache.at < FIELD_CACHE_TTL_MS) return fieldCache.map;

  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/rest/api/3/field`, {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return fieldCache?.map ?? {};

    const fields = (await response.json()) as { id: string; name?: string }[];
    const map: Record<string, string[]> = {};

    for (const field of fields) {
      const key = (field.name ?? "").toLowerCase();
      if (!map[key]) map[key] = [];
      map[key].push(field.id);
    }

    fieldCache = { map, at: Date.now() };
    return map;
  } catch {
    // A failed lookup falls back to whatever was cached rather than erasing it —
    // the sync can still run against the ids it already knows.
    return fieldCache?.map ?? {};
  }
}

export function pickFieldValue(fields: Record<string, unknown>, ids: string[] | undefined): unknown {
  for (const id of ids ?? []) {
    const value = fields[id];
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    if (!empty) return value;
  }
  return null;
}

/** Single-value "labels" fields (Account Name, Branch) still come back as a
 *  one-element array from Jira's API — unwrap to a plain value. */
export function firstOf(value: unknown): string | null {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return value === null || value === undefined ? null : String(value);
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return value === null || value === undefined ? [] : [String(value)];
}

// ---------- one-off calls ----------

export interface JiraLookup {
  key: string;
  summary: string;
  status: string;
  accountName: string | null;
  branch: string | null;
  repository: string[];
  ticketAssignees: string[];
  startDate: string | null;
  dueDate: string | null;
}

/** One ticket by key, for the Assign form's autofill. */
export async function lookupIssue(key: string): Promise<JiraLookup | null> {
  const config = loadJiraConfig();
  if (!config) return null;

  const fieldMap = await loadFieldIdMap(config);
  const ids = new Set(["summary", "status"]);
  for (const name of AUTOFILL_FIELD_NAMES) {
    for (const id of fieldMap[name] ?? []) ids.add(id);
  }

  const url =
    `${normalizeBaseUrl(config.baseUrl)}/rest/api/3/issue/${encodeURIComponent(key)}` +
    `?fields=${encodeURIComponent([...ids].join(","))}`;

  const response = await fetch(url, {
    headers: { Authorization: authHeader(config), Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;

  const issue = (await response.json()) as {
    key: string;
    fields: Record<string, unknown> & { summary?: string; status?: { name?: string } };
  };
  const f = issue.fields;

  return {
    key: issue.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "Unknown",
    accountName: firstOf(pickFieldValue(f, fieldMap["account name"])),
    branch: firstOf(pickFieldValue(f, fieldMap["branch"])),
    repository: asStringArray(pickFieldValue(f, fieldMap["repository"])),
    ticketAssignees: asStringArray(pickFieldValue(f, fieldMap["ticket assignee"])),
    startDate: firstOf(pickFieldValue(f, fieldMap["start date"])),
    dueDate: firstOf(pickFieldValue(f, fieldMap["due date"])),
  };
}

/** Verifies the credentials without touching any issue. */
export async function testConnection(): Promise<{ ok: boolean; error?: string; account?: string }> {
  const config = loadJiraConfig();
  if (!config) {
    return { ok: false, error: "JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set." };
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/rest/api/3/myself`, {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { ok: false, error: `Jira answered ${response.status}. Check the email and API token.` };
    }
    const me = (await response.json()) as { displayName?: string; emailAddress?: string };
    return { ok: true, account: me.displayName ?? me.emailAddress ?? config.email };
  } catch (err) {
    return { ok: false, error: `Couldn't reach Jira: ${(err as Error).message}` };
  }
}

/** Leaves a comment on a ticket — used when a claim is released, if enabled. */
export async function addComment(key: string, body: string): Promise<boolean> {
  const config = loadJiraConfig();
  if (!config) return false;

  try {
    const response = await fetch(commentPath(config.baseUrl, key), {
      method: "POST",
      headers: {
        Authorization: authHeader(config),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      // Atlassian Document Format — the v3 API will not take a plain string.
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
