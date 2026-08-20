"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BOARD_CHANNEL, userChannel } from "@/lib/realtime/channels";
import { BOARD_EVENT_NAMES } from "@/lib/realtime/events";
import { getPusher, realtimeEnabled, type ConnectionState } from "@/lib/realtime/client";

/**
 * Subscribes to the board and to this user's own channel, and turns both into
 * one thing: a refresh of the server-rendered tree.
 *
 * ── Why refresh rather than patch a store ──
 *
 * Every page here renders from Postgres in a Server Component, so the database
 * is already the single source of truth. `router.refresh()` re-runs those
 * components and repaints with the server's own answer. Maintaining a parallel
 * client-side copy of the board is exactly what the legacy `appData` mirror did,
 * and keeping it in step was most of where its bugs lived.
 *
 * The message list in phase 9 will be the one exception: refetching a paginated
 * thread on every incoming message is both slow and scroll-destroying, so it
 * keeps its own append-only list.
 *
 * ── Catch-up ──
 *
 * PUSHER DOES NOT REPLAY. Anything published while a tab was disconnected is
 * lost to that tab forever. So every transition back into `connected` triggers a
 * refresh, which for server-rendered pages is a complete catch-up. Without this,
 * closing a laptop lid quietly desynchronises the board until the next
 * navigation — and once chat exists, the same gap silently drops messages.
 */

interface RealtimeContextValue {
  state: ConnectionState;
  enabled: boolean;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  state: "initialized",
  enabled: false,
});

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

/** At most one refresh per window, however many events arrive. */
const REFRESH_DEBOUNCE_MS = 300;

export function PusherProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const router = useRouter();
  const enabled = realtimeEnabled();
  const [state, setState] = useState<ConnectionState>(enabled ? "connecting" : "initialized");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A first `connected` needs no catch-up: the page was just rendered by the
  // server. Only a RE-connect implies missed events.
  const hasConnected = useRef(false);

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [router]);

  useEffect(() => {
    if (!enabled) return;

    const pusher = getPusher();
    if (!pusher) return;

    const onState = ({ current }: { current: string }) => {
      setState(current as ConnectionState);

      if (current === "connected") {
        if (hasConnected.current) scheduleRefresh(); // reconnect → catch up
        hasConnected.current = true;
      }
    };

    pusher.connection.bind("state_change", onState);
    setState(pusher.connection.state as ConnectionState);

    const board = pusher.subscribe(BOARD_CHANNEL);
    for (const event of BOARD_EVENT_NAMES) board.bind(event, scheduleRefresh);

    const mine = pusher.subscribe(userChannel(userId));
    mine.bind("session.revoked", () => {
      // A full navigation, not router.push: it drops every cached Server
      // Component payload along with the session, so nothing from the
      // signed-in board survives in the router cache.
      window.location.href = "/login?expired=1";
    });
    mine.bind("unread.changed", scheduleRefresh);
    mine.bind("conversation.added", scheduleRefresh);

    return () => {
      pusher.connection.unbind("state_change", onState);
      for (const event of BOARD_EVENT_NAMES) board.unbind(event, scheduleRefresh);
      // Unsubscribe, but deliberately do NOT disconnect: the client is a
      // module-level singleton shared across navigations, and tearing the
      // socket down on every route change would reconnect constantly.
      pusher.unsubscribe(BOARD_CHANNEL);
      pusher.unsubscribe(userChannel(userId));
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, userId, scheduleRefresh]);

  const value = useMemo(() => ({ state, enabled }), [state, enabled]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
