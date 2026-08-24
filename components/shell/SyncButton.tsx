"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toaster";
import { realtimeHeaders } from "@/lib/realtime/client";
import { agoText } from "@/lib/shared/format";

/**
 * "Synced 3m ago" — and pressing it syncs.
 *
 * This was a read-only pill in the header. Making the freshness indicator the
 * button that refreshes it is the whole point: the moment you notice the number
 * is stale is the moment you want to act on it, and until now that meant
 * navigating to Settings to find **Sync now**.
 *
 * ── Why every signed-in person may press it ──
 *
 * POST /api/jira/sync-now asks only for `view`, and deliberately: pulling
 * sooner shows nothing a viewer could not already have seen a minute later. The
 * legacy app reasoned the same way. So there is no capability check here — the
 * server is still the boundary (invariant 3), it just draws it at `view`.
 *
 * ── Why it forces ──
 *
 * The route runs `runJiraSync(true)`. A person pressing a button wants an
 * answer, not the server's opinion about whether one is due — that is what the
 * cron and the dashboard's JiraAutoSync are for, and both of those pass false so
 * several open tabs coalesce into one call. Cron cannot go below a minute, so
 * this button is the only route to sub-minute freshness.
 *
 * `realtimeHeaders()` carries this tab's socket id, so the sync event it causes
 * comes back to everyone *else* — this tab already knows, and refreshes itself.
 */

type Reason = "disabled" | "auto-sync-off" | "not-configured" | "throttled" | "error";

interface SyncResponse {
  ok?: boolean;
  reason?: Reason;
  error?: string;
  issueCount?: number;
  claimed?: number;
  released?: number;
  skippedCount?: number;
}

/** Why a sync did nothing, said in terms of what to do about it. `error`
 *  carries Jira's own message, so it falls through to the response. */
const REASONS: Record<Exclude<Reason, "error">, string> = {
  disabled: "Jira is switched off. Turn it on under Settings › Jira.",
  "not-configured": "Jira credentials are not set on this deployment.",
  // Neither can happen on a forced sync. Said plainly anyway rather than left to
  // fall through as a silent success, which would read as "nothing changed".
  "auto-sync-off": "Scheduled sync is off, and this request did not force one.",
  throttled: "Synced a moment ago — showing that result.",
};

function outcomeText(data: SyncResponse): string {
  const parts = [`${data.issueCount ?? 0} ticket${data.issueCount === 1 ? "" : "s"} read`];
  if (data.claimed) parts.push(`${data.claimed} claimed`);
  if (data.released) parts.push(`${data.released} released`);
  if (data.skippedCount) parts.push(`${data.skippedCount} not tracked`);
  // Worth saying out loud: a sync that changed nothing is the normal case, and
  // silence about it reads as the button not having worked.
  if (parts.length === 1) parts.push("nothing changed");
  return parts.join(" · ");
}

export function SyncButton({
  jiraEnabled,
  lastSyncAt,
}: {
  jiraEnabled: boolean;
  lastSyncAt: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const label = !jiraEnabled
    ? "Jira off"
    : busy
      ? "Syncing…"
      : lastSyncAt
        ? `Synced ${agoText(lastSyncAt)} ago`
        : "Not synced yet";

  async function syncNow() {
    if (busy || !jiraEnabled) return;
    setBusy(true);

    const response = await fetch("/api/jira/sync-now", {
      method: "POST",
      headers: realtimeHeaders(),
    }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as SyncResponse | null;

    setBusy(false);

    // One key for all of them, so a run of impatient presses replaces its own
    // toast instead of stacking four.
    if (!response || !data?.ok) {
      toast.show({
        key: "jira:sync-now",
        title: "Jira sync didn't run",
        body:
          data?.error ??
          (data?.reason && data.reason !== "error" ? REASONS[data.reason] : null) ??
          "Couldn't reach the server.",
      });
      return;
    }

    toast.show({ key: "jira:sync-now", title: "Jira synced", body: outcomeText(data) });

    // The board renders from Postgres and the sync wrote to Postgres, so a
    // refresh is how this tab sees it. Other tabs get the realtime event.
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      // Busy does NOT disable it: `disabled:opacity-50` on a spinning icon and a
      // "Syncing…" label greys out the one thing worth reading. The handler
      // guards instead, so a second press while one is in flight is a no-op.
      disabled={!jiraEnabled}
      aria-busy={busy}
      aria-label={jiraEnabled ? "Sync Jira now" : "Jira integration is off"}
      title={
        !jiraEnabled
          ? "Jira integration is off"
          : busy
            ? "Syncing with Jira…"
            : `${label} — click to sync now`
      }
      className="flex h-9 max-w-[170px] items-center gap-2 rounded-xl bg-subtle px-3 text-xs font-semibold text-muted ring-1 ring-line-soft transition hover:bg-subtle-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-subtle disabled:hover:text-muted"
    >
      <Icon name="refresh" className={`h-3.5 w-3.5 shrink-0 text-faint ${busy ? "animate-spin" : ""}`} />
      {/* The label is the first thing to go when the header runs out of room;
          the icon alone still reads as "sync". */}
      <span className="hidden truncate lg:inline">{label}</span>
    </button>
  );
}
