/**
 * Default settings, ported from DEFAULT_SETTINGS in the legacy shared/data.js.
 *
 * The `jira` block is stored as jsonb (docs/02-DATA-MODEL.md §2), so a row
 * written by an older deploy can be missing keys that were added later. Rather
 * than a migration per option, reads go through `withSettingsDefaults()`, which
 * is the Postgres equivalent of what `migrateAppData()` did for the JSON file.
 */

import type { JiraSettings, Settings } from "@/lib/types";

export const DEFAULT_JIRA_SETTINGS: JiraSettings = {
  enabled: false,
  requireTicket: true,
  pullTicketInfo: true,
  commentOnRelease: false,
  /** A ticket claims its matched repos the moment it reaches one of these. */
  occupyingStatuses: ["QA TESTING (DEV)", "QA TESTING (STG)"],
  /** …and releases them the moment it reaches one of these. Any *other* status
   *  leaves an existing claim as-is — QA FAILED doesn't free the environment,
   *  it's still being worked. */
  releasingStatuses: ["FINAL CHECKING", "DONE"],
  /**
   * Statuses the sync does not ask Jira for at all. A ticket parked at one of
   * these is not waiting on an environment and not on its way to one, so pulling
   * it only to file it away costs a request, a row, and a chunk of every payload.
   * Cut in the JQL, not after the fact.
   *
   * The one exception is a ticket already holding repositories: its key is asked
   * for by name whatever status it reached, because reaching one of these is
   * often exactly how a claim ends.
   */
  ignoredStatuses: ["OPEN", "TO REVIEW", "ON HOLD", "CANCELLED", "DONE", "CLOSED"],
  pollIntervalMinutes: 1,
  autoSync: true,
};

export const DEFAULT_SETTINGS: Settings = {
  defaultBookingHours: 4,
  onExpiry: "remind",
  /** Claiming is per-repo, but most bookings take the whole environment. On,
   *  the Assign form starts with every free repo ticked. */
  assignWholeEnv: true,
  jira: DEFAULT_JIRA_SETTINGS,
};

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Fills in anything a stored jsonb blob is missing, without mutating input. */
export function withJiraDefaults(stored: unknown): JiraSettings {
  const raw = (stored ?? {}) as Partial<Record<keyof JiraSettings, unknown>>;
  const d = DEFAULT_JIRA_SETTINGS;

  const interval = Number(raw.pollIntervalMinutes);

  return {
    enabled: bool(raw.enabled, d.enabled),
    requireTicket: bool(raw.requireTicket, d.requireTicket),
    pullTicketInfo: bool(raw.pullTicketInfo, d.pullTicketInfo),
    commentOnRelease: bool(raw.commentOnRelease, d.commentOnRelease),
    occupyingStatuses: stringList(raw.occupyingStatuses, d.occupyingStatuses),
    releasingStatuses: stringList(raw.releasingStatuses, d.releasingStatuses),
    ignoredStatuses: stringList(raw.ignoredStatuses, d.ignoredStatuses),
    // Guard the floor: a 0 or negative interval would make the sync run on
    // every single tick, which is how you get rate-limited by Jira.
    pollIntervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : d.pollIntervalMinutes,
    autoSync: bool(raw.autoSync, d.autoSync),
  };
}
