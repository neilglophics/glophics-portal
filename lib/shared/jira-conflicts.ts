import { statusIn } from "@/lib/jira/matching";

const CONFLICT_STATUSES = ["IN PROGRESS", "QA TESTING (STG)"] as const;

export interface JiraConflictCandidate {
  ticketId: string;
  status: string;
  accountName: string;
  branch: string | null;
  repos: string[];
}

export interface JiraBranchConflict {
  ticketIds: string[];
  repos: string[];
}

const normalized = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/**
 * Finds tickets that should not share a branch while work is active.
 *
 * Both tickets must be IN PROGRESS or QA TESTING (STG), under the same account
 * and branch, with at least one repository in common. Comparisons are exact and
 * case-insensitive, matching the Jira field rules used by the sync.
 */
export function jiraBranchConflicts(
  candidates: readonly JiraConflictCandidate[],
): Map<string, JiraBranchConflict> {
  const conflicts = new Map<string, JiraBranchConflict>();
  const eligible = candidates.filter(
    (candidate) =>
      statusIn(CONFLICT_STATUSES, candidate.status) &&
      normalized(candidate.accountName) &&
      normalized(candidate.branch) &&
      candidate.repos.length,
  );

  const addConflict = (ticket_id: string, conflicting_id: string, repos: string[]) => {
    const current = conflicts.get(ticket_id) ?? { ticketIds: [], repos: [] };
    if (!current.ticketIds.includes(conflicting_id)) current.ticketIds.push(conflicting_id);
    for (const repo of repos) {
      if (!current.repos.some((item) => normalized(item) === normalized(repo))) current.repos.push(repo);
    }
    conflicts.set(ticket_id, current);
  };

  for (let left_index = 0; left_index < eligible.length; left_index += 1) {
    const left = eligible[left_index]!;

    for (let right_index = left_index + 1; right_index < eligible.length; right_index += 1) {
      const right = eligible[right_index]!;
      if (left.ticketId === right.ticketId) continue;
      if (normalized(left.accountName) !== normalized(right.accountName)) continue;
      if (normalized(left.branch) !== normalized(right.branch)) continue;

      const right_repos = new Set(right.repos.map(normalized));
      const shared_repos = left.repos.filter((repo) => right_repos.has(normalized(repo)));
      if (!shared_repos.length) continue;

      addConflict(left.ticketId, right.ticketId, shared_repos);
      addConflict(right.ticketId, left.ticketId, shared_repos);
    }
  }

  return conflicts;
}
