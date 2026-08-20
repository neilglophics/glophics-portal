/**
 * Jira matching rules — ported from the legacy shared/data.js.
 *
 * These decide which environment a ticket claims, who it belongs to, and when it
 * lets go. Both the sync job and the Assign form's ticket autofill run them, so
 * the two cannot disagree about what a label means.
 *
 * Matching is deliberately **exact, case-insensitive, and never fuzzy**. A
 * ticket that cannot be placed is reported on the Not-tracked page with the
 * reason and the fix, rather than silently claiming the wrong box.
 */

import type { Account, DirectoryUser, Environment, JiraSettings } from "@/lib/types";

/**
 * Statuses that end a ticket's life. Nothing here is waiting on an environment,
 * whatever the configured releasing statuses happen to be.
 */
export const JIRA_TERMINAL_STATUSES = ["DONE", "CLOSED", "CANCELLED"] as const;

/**
 * The team's full sub-task workflow vocabulary, shown in Settings so
 * "Occupies"/"Frees" can be picked from the statuses actually in use rather
 * than typed from memory.
 */
export const JIRA_STATUS_VOCABULARY = [
  "OPEN",
  "IN PROGRESS",
  "TO REVIEW",
  "QA FAILED",
  "CANCELLED",
  "ON HOLD",
  "QA TESTING (DEV)",
  "QA TESTING (STG)",
  "LIVE DEPLOYMENT",
  "QA TESTING (LIVE)",
  "FINAL CHECKING",
  "DONE",
  "CLOSED",
] as const;

/**
 * Whether a status is in one of the configured lists. Jira reports its own
 * casing ("QA Testing (Stg)") and the lists are written in whatever the reader
 * typed, so every status comparison in the app goes through here.
 */
export function statusIn(list: readonly string[] | null | undefined, statusName: string | null | undefined): boolean {
  const needle = String(statusName ?? "").trim().toLowerCase();
  return (list ?? []).some((s) => String(s).trim().toLowerCase() === needle);
}

export function statusIsTerminal(status: string | null | undefined): boolean {
  return statusIn(JIRA_TERMINAL_STATUSES, status);
}

/**
 * Whether a ticket at this status has stopped holding its repositories.
 *
 * Two ways to stop: the team's own releasing list, and reaching the end of the
 * ticket's life. The second is not a preference — a cancelled or closed ticket
 * is nobody's work in progress, and leaving an environment held in its name is a
 * booking nothing will ever come back to clear. So a terminal status frees the
 * environment whatever the lists say, and by the same argument can never take one.
 */
export function statusFrees(jira: Pick<JiraSettings, "releasingStatuses"> | null | undefined, status: string): boolean {
  return statusIn(jira?.releasingStatuses, status) || statusIsTerminal(status);
}

/**
 * The "Repository" ticket field is free-text labels, not our repo keys —
 * translate the known synonyms. (Confirmed: API = backend. Admin/Frontend are
 * the literal reading of admin panel vs. customer storefront.)
 */
const REPO_LABEL_SYNONYMS: Record<string, string> = {
  api: "backend",
  backend: "backend",
  admin: "admin",
  frontend: "storefront",
  storefront: "storefront",
};

export function matchRepositoriesToKeys(
  labels: readonly string[] | null | undefined,
  validKeys: readonly string[],
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const label of labels ?? []) {
    const key = REPO_LABEL_SYNONYMS[String(label ?? "").trim().toLowerCase()];
    if (key && validKeys.includes(key)) matched.push(key);
    else unmatched.push(label);
  }
  return { matched, unmatched };
}

/**
 * The labels Jira may write for one person. Empty falls back to the display
 * name, so a directory that predates the field still matches.
 */
export function userJiraNames(user: Pick<DirectoryUser, "name" | "jiraNames">): string[] {
  const names = (user.jiraNames ?? []).map((n) => (n ?? "").trim()).filter(Boolean);
  if (names.length) return names;
  const fallback = (user.name ?? "").trim();
  return fallback ? [fallback] : [];
}

/**
 * Matches a ticket's "Ticket Assignee" labels against directory people by their
 * Jira names — exact first, then case-insensitive.
 *
 * One person can carry several labels (the same tester is "[QA]_Jerome" on one
 * board and "[QA]_Jerome_C" on another), so a label that matched nobody is
 * **reported rather than guessed at**.
 */
export function matchUserIdsByLabels(
  labels: readonly string[] | null | undefined,
  users: readonly Pick<DirectoryUser, "id" | "name" | "jiraNames">[],
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const label of labels ?? []) {
    const raw = String(label ?? "").trim();
    const lower = raw.toLowerCase();
    const hit =
      users.find((u) => userJiraNames(u).some((n) => n === raw)) ??
      users.find((u) => userJiraNames(u).some((n) => n.toLowerCase() === lower));

    if (!hit) unmatched.push(label);
    else if (!matched.includes(hit.id)) matched.push(hit.id);
  }
  return { matched, unmatched };
}

/**
 * A ticket names its account ("Account Name") and its environment ("Branch",
 * expected to equal the environment's own name). No fuzzy guessing beyond a
 * case-insensitive exact match, so a mismatch is reported rather than silently
 * claiming the wrong box.
 */
export function findServerForTicket(
  ticket: { accountName?: string | null; branch?: string | null },
  accounts: readonly Account[],
  environments: readonly Environment[],
): { server: Environment } | { error: string } {
  const accountName = (ticket.accountName ?? "").trim().toLowerCase();
  const branch = (ticket.branch ?? "").trim().toLowerCase();

  if (!accountName) return { error: "Account Name is empty." };
  if (!branch) return { error: "Branch is empty." };

  const account = accounts.find((a) => a.displayName.trim().toLowerCase() === accountName);
  if (!account) return { error: `No account named "${ticket.accountName}" is configured.` };

  const server = environments.find(
    (s) => s.accountId === account.id && s.name.trim().toLowerCase() === branch,
  );
  if (!server) return { error: `No environment named "${ticket.branch}" under ${account.displayName}.` };

  return { server };
}
