/**
 * "Sync Jira now", asked from the browser — and the one place that says what
 * came of it.
 *
 * Two controls make this request: the freshness pill in the header
 * (components/shell/SyncButton.tsx) and Refresh on My tickets
 * (components/tickets/RefreshTickets.tsx). They have to report the same
 * outcome, including the awkward cases where the sync declines to run, so the
 * wording lives here rather than in both.
 *
 * Browser-only by intent. It imports nothing from ./client.ts, which holds the
 * Jira API token — invariant 5 is about secrets never reaching the client, and
 * the cheapest way to keep it is for client-side code never to reach for the
 * module that has them.
 *
 * ── Why every signed-in person may call it ──
 *
 * POST /api/jira/sync-now asks only for `view`, and deliberately: pulling
 * sooner shows nothing a viewer could not have seen a minute later. The legacy
 * app reasoned the same way. The server is still the boundary (invariant 3), it
 * just draws it at `view`.
 */

import { realtimeHeaders } from "@/lib/realtime/client";

export type SyncReason = "disabled" | "auto-sync-off" | "not-configured" | "throttled" | "error";

export interface SyncResponse {
  ok?: boolean;
  reason?: SyncReason;
  error?: string;
  /** Which kind of pass ran. Both buttons ask for `full`, so this is a check on
   *  what the server actually did rather than a branch either of them takes. */
  mode?: "full" | "delta";
  issueCount?: number;
  claimed?: number;
  released?: number;
  skippedCount?: number;
}

/** Why a sync did nothing, said in terms of what to do about it. `error`
 *  carries Jira's own message, so it falls through to the response. */
const REASONS: Record<Exclude<SyncReason, "error">, string> = {
  disabled: "Jira is switched off. Turn it on under Settings › Jira.",
  "not-configured": "Jira credentials are not set on this deployment.",
  // Neither can happen on a forced sync. Said plainly anyway rather than left to
  // fall through as a silent success, which would read as "nothing changed".
  "auto-sync-off": "Scheduled sync is off, and this request did not force one.",
  throttled: "Synced a moment ago — showing that result.",
};

export function outcomeText(data: SyncResponse): string {
  // A delta pass reading 3 tickets has not looked at 3 tickets in Jira — it has
  // looked at everything that CHANGED. Saying which kind of pass it was is the
  // difference between "the board is nearly empty" and "nothing moved".
  const scope = data.mode === "delta" ? " changed" : "";
  const parts = [`${data.issueCount ?? 0}${scope} ticket${data.issueCount === 1 ? "" : "s"} read`];
  if (data.claimed) parts.push(`${data.claimed} claimed`);
  if (data.released) parts.push(`${data.released} released`);
  if (data.skippedCount) parts.push(`${data.skippedCount} not tracked`);
  // Worth saying out loud: a sync that changed nothing is the normal case, and
  // silence about it reads as the button not having worked.
  if (parts.length === 1) parts.push("nothing changed");
  return parts.join(" · ");
}

export interface SyncOutcome {
  ok: boolean;
  title: string;
  /** One line, ready to show. Never empty. */
  body: string;
}

/**
 * Always FORCES.
 *
 * A person pressing a button wants an answer, not the server's opinion about
 * whether one is due — that is what the cron and the dashboard's JiraAutoSync
 * are for, and both of those pass false so several open tabs coalesce into one
 * call. Cron cannot go below a minute, so a forced call is the only route to
 * sub-minute freshness.
 *
 * `realtimeHeaders()` carries this tab's socket id, so the sync event it causes
 * goes to everyone *else* — the calling tab already knows, and refreshes itself.
 */
export async function requestJiraSync(): Promise<SyncOutcome> {
  const response = await fetch("/api/jira/sync-now", {
    method: "POST",
    headers: realtimeHeaders(),
  }).catch(() => null);

  const data = (await response?.json().catch(() => null)) as SyncResponse | null;

  if (!response || !data?.ok) {
    return {
      ok: false,
      title: "Jira sync didn't run",
      body:
        data?.error ??
        (data?.reason && data.reason !== "error" ? REASONS[data.reason] : null) ??
        "Couldn't reach the server.",
    };
  }

  return { ok: true, title: "Jira synced", body: outcomeText(data) };
}
