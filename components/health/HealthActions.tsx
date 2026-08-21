"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { realtimeHeaders } from "@/lib/realtime/client";
import { HEALTH_CHECK_INTERVAL_MS, isPassDue } from "@/lib/shared/health";

/**
 * "Check servers", and the timer that means nobody has to press it.
 *
 * ── Why the page carries a schedule at all ──
 *
 * The scheduled pass is a Vercel Cron entry, and cron only exists on a
 * deployment. Under `npm run dev` there is no scheduler, so on localhost the
 * board would be exactly as fresh as the last button press. This closes that:
 * while somebody has the Health page open, a pass is requested whenever the
 * newest result is more than an hour old. In development that IS the schedule;
 * in production it is a harmless duplicate of one.
 *
 * Same division of labour as JiraAutoSync on the dashboard: the tab asks, the
 * SERVER decides. The automatic path does not force, so several open tabs all
 * deciding a check is due at the same moment coalesce into one pass instead of
 * one each. The button forces, because a person pressing it wants a measurement
 * rather than the server's opinion of whether one is needed.
 *
 * `attemptedAt` records the attempt and not the result, so a pass the server
 * skipped — or one that failed outright — still counts as "this tab tried" and
 * cannot spin into a retry loop.
 */

/** How often the tab reconsiders whether a pass is due. It is a comparison, and
 *  only a due check costs a request — a repeating tick survives a sleeping
 *  laptop that would silently stretch one long timeout. */
const TICK_MS = 60_000;

export function HealthActions({
  lastCheckedAt,
  checkableCount,
}: {
  lastCheckedAt: string | null;
  /** Repositories with a URL — the ones a pass can actually probe. Zero means
   *  there is nothing to measure and the automatic path must stay off, or it
   *  would ask for ever: with no URLs anywhere, no pass can ever set a
   *  `health_checked_at` for it to be satisfied by. */
  checkableCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Set BEFORE the request, so the automatic path cannot start a second pass
  // while the first is still in flight.
  const attemptedAt = useRef<number>(0);
  const inFlight = useRef(false);

  const run = useCallback(
    async (force: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      attemptedAt.current = Date.now();
      setBusy(true);
      setMessage(null);

      const res = await fetch(`/api/health/check${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: realtimeHeaders(),
      }).catch(() => null);

      const data = (await res?.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        skipped?: boolean;
        online?: number;
        offline?: number;
        changed?: unknown[];
      };

      inFlight.current = false;
      setBusy(false);

      if (!res || data.ok === false) {
        setMessage(data.error ?? "Couldn't run the check.");
        return;
      }

      setMessage(
        data.skipped
          ? "Checked a moment ago — showing that result"
          : `${data.online ?? 0} online, ${data.offline ?? 0} offline` +
              (data.changed?.length ? ` · ${data.changed.length} changed` : " · no changes"),
      );

      // The results are in Postgres and this page renders from Postgres, so a
      // refresh is how this tab sees them. Other tabs get the server.health
      // event and refresh themselves.
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (checkableCount === 0) return;

    const tick = () => {
      if (document.visibilityState === "hidden") return;
      // Whichever is later wins. A stamp from somebody else's pass means the
      // data is current; an attempt of our own means we have already asked.
      const latest = Math.max(attemptedAt.current, lastCheckedAt ? new Date(lastCheckedAt).getTime() : 0);
      if (isPassDue(latest ? new Date(latest).toISOString() : null)) void run(false);
    };

    tick();
    const timer = window.setInterval(tick, TICK_MS);
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [lastCheckedAt, checkableCount, run]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="dark" onClick={() => void run(true)} disabled={busy || checkableCount === 0}>
        <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Checking…" : "Check servers"}
      </Button>
      <span className="text-[11px] text-faint" role="status">
        {message ??
          (checkableCount === 0
            ? "No repository has a URL to check"
            : `Auto-checks every ${Math.round(HEALTH_CHECK_INTERVAL_MS / 60_000)} min while this page is open`)}
      </span>
    </div>
  );
}
