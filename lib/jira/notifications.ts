import { jiraBranchConflicts } from "@/lib/shared/jira-conflicts";

export interface JiraNotificationTicket {
  ticketId: string;
  status: string;
  summary: string | null;
  accountName: string | null;
  branch: string | null;
  repos: string[];
  userIds: string[];
}

export interface JiraNotificationChange {
  kind: "assigned" | "status-changed" | "conflict";
  ticketId: string;
  directoryUserIds: string[];
  title: string;
  body: string;
  relatedTicketIds?: string[];
}

const normalized = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/** Converts two Jira snapshots into user-facing changes without repeating an unchanged conflict. */
export function jiraNotificationChanges(
  previous: readonly JiraNotificationTicket[],
  current: readonly JiraNotificationTicket[],
): JiraNotificationChange[] {
  const previous_by_id = new Map(previous.map((ticket) => [ticket.ticketId, ticket]));
  const changes: JiraNotificationChange[] = [];

  for (const ticket of current) {
    const before = previous_by_id.get(ticket.ticketId);
    const previous_users = new Set(before?.userIds ?? []);
    const newly_assigned = ticket.userIds.filter((user_id) => !previous_users.has(user_id));

    if (newly_assigned.length) {
      changes.push({
        kind: "assigned",
        ticketId: ticket.ticketId,
        directoryUserIds: newly_assigned,
        title: `${ticket.ticketId} was assigned to you`,
        body: ticket.summary?.trim() || `Current status: ${ticket.status}`,
      });
    }

    if (before && normalized(before.status) !== normalized(ticket.status)) {
      const newly_assigned_set = new Set(newly_assigned);
      const existing_assignees = ticket.userIds.filter((user_id) => !newly_assigned_set.has(user_id));
      if (existing_assignees.length) {
        changes.push({
          kind: "status-changed",
          ticketId: ticket.ticketId,
          directoryUserIds: existing_assignees,
          title: `${ticket.ticketId} status changed`,
          body: `${before.status} → ${ticket.status}`,
        });
      }
    }
  }

  const to_conflict_candidates = (tickets: readonly JiraNotificationTicket[]) =>
    tickets.map((ticket) => ({
      ticketId: ticket.ticketId,
      status: ticket.status,
      accountName: ticket.accountName ?? "",
      branch: ticket.branch,
      repos: ticket.repos,
    }));
  const previous_conflicts = jiraBranchConflicts(to_conflict_candidates(previous));
  const current_conflicts = jiraBranchConflicts(to_conflict_candidates(current));

  for (const ticket of current) {
    const conflict = current_conflicts.get(ticket.ticketId);
    if (!conflict || !ticket.userIds.length) continue;

    const previous_related = new Set(previous_conflicts.get(ticket.ticketId)?.ticketIds ?? []);
    const new_related = conflict.ticketIds.filter((ticket_id) => !previous_related.has(ticket_id));
    if (!new_related.length) continue;

    changes.push({
      kind: "conflict",
      ticketId: ticket.ticketId,
      directoryUserIds: ticket.userIds,
      relatedTicketIds: new_related,
      title: `Branch conflict on ${ticket.ticketId}`,
      body: `Also used by ${new_related.join(", ")} on ${conflict.repos.join(", ")}. Use a different branch.`,
    });
  }

  return changes;
}
