/**
 * "What's newsworthy about this ticket" — a short badge plus the sentence
 * behind it, for the dashboard's Latest Jira updates panel.
 *
 * Checked most-specific first: a ticket created today is "New" even if it
 * also just started holding a repository; one that's been open for weeks but
 * just claimed an environment is "Claimed"; anything else touched recently is
 * a plain status refresh.
 *
 * Nothing here is a diff against a previous sync — the board keeps no history
 * of what a ticket's fields used to be — so every message says what Jira
 * reports *now* (current status, current branch), not what it changed from.
 */

import { claimIsMine, identityValues } from "./mine";
import { peopleOf, type TicketRow } from "./view-model";
import type { AuthUser, Claim, DirectoryUser } from "@/lib/types";

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function isRecent(iso: string | null, now: number): boolean {
  return !!iso && now - new Date(iso).getTime() < RECENT_WINDOW_MS;
}

/** Whether Jira reports this ticket as created within the last day. Based on
 *  Jira's own `created` instant rather than "first sync pass that saw it", so
 *  a ticket already a day old when Jira is first connected doesn't wrongly
 *  read as new. */
export function isNewTicket(claim: Claim, now = Date.now()): boolean {
  return isRecent(claim.jiraCreatedAt, now);
}

/** Who a ticket is assigned to, in words — "you" when the signed-in person is
 *  one of the assignees, since that's the reading that matters most to
 *  whoever is looking at their own board. */
function assigneeSuffix(claim: Claim, directory: DirectoryUser[], mine: Set<string>): string {
  const people = peopleOf([claim], directory);
  if (!people.length) return "unassigned";
  if (claimIsMine(claim, mine, directory)) return "assigned to you";
  return `assigned to ${people.map((p) => p.name).join(", ")}`;
}

export interface JiraActivity {
  badge: "New" | "Claimed" | "Updated";
  chipClassName: string;
  message: string;
}

export function jiraActivity(
  row: TicketRow,
  directory: DirectoryUser[],
  user: AuthUser | null,
  now = Date.now(),
): JiraActivity | null {
  const claim = row.claim;
  const mine = identityValues(user, directory);
  const who = assigneeSuffix(claim, directory, mine);

  if (isNewTicket(claim, now)) {
    return { badge: "New", chipClassName: "bg-brand-500 text-white", message: `New ticket created, ${who}` };
  }
  if (row.holding && isRecent(claim.claimedAt, now)) {
    return {
      badge: "Claimed",
      chipClassName: "bg-warn-soft text-warn",
      message: `Now holding ${claim.branch ?? row.env}, ${who}`,
    };
  }
  if (isRecent(claim.jiraUpdatedAt, now)) {
    return {
      badge: "Updated",
      chipClassName: "bg-info-soft text-info",
      message: `Status updated to ${claim.status || "Unknown"}, ${who}`,
    };
  }
  return null;
}
