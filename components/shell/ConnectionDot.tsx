"use client";

import { useRealtime } from "@/components/providers/PusherProvider";

/**
 * The live-connection indicator. Replaces the placeholder that only reported
 * Jira freshness, and the legacy SSE dot before that.
 *
 * It distinguishes three states that mean genuinely different things, because
 * conflating them is how a stale board gets read as a live one:
 *
 *   connected    changes from other people arrive on their own
 *   reconnecting the connection dropped; pusher-js is retrying with backoff
 *   off         realtime is not configured at all — this deployment never
 *                had live updates, which is not a fault to alarm anyone about
 */
const LABELS: Record<string, { dot: string; text: string; title: string }> = {
  connected: {
    dot: "bg-ok",
    text: "Live",
    title: "Connected — changes from other people appear on their own",
  },
  connecting: {
    dot: "bg-warn animate-pulse",
    text: "Connecting…",
    title: "Connecting to the live update service",
  },
  unavailable: {
    dot: "bg-warn animate-pulse",
    text: "Reconnecting…",
    title: "Lost the connection. Retrying — the board may be behind until it returns.",
  },
  disconnected: {
    dot: "bg-warn animate-pulse",
    text: "Reconnecting…",
    title: "Lost the connection. Retrying — the board may be behind until it returns.",
  },
  failed: {
    dot: "bg-bad",
    text: "No live updates",
    title: "Could not connect. Reload the page, or carry on and refresh manually.",
  },
  initialized: { dot: "bg-faintest", text: "Starting…", title: "Starting up" },
};

export function ConnectionDot() {
  const { state, enabled } = useRealtime();

  if (!enabled) {
    return (
      <div
        title="Live updates are not configured for this deployment. Changes you make still save; you just need to refresh to see other people's."
        className="hidden shrink-0 items-center gap-2 text-xs font-medium text-faint md:flex"
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-faintest" />
        <span className="truncate">Not live</span>
      </div>
    );
  }

  const token = LABELS[state] ?? LABELS.initialized!;

  return (
    <div
      title={token.title}
      className="hidden shrink-0 items-center gap-2 text-xs font-medium text-muted md:flex"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${token.dot}`} />
      <span className="truncate">{token.text}</span>
    </div>
  );
}
