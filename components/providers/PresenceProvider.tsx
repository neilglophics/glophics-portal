"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ORG_PRESENCE_CHANNEL } from "@/lib/realtime/channels";
import { getPusher, realtimeEnabled } from "@/lib/realtime/client";

/**
 * Who is online.
 *
 * ── The channel IS the state ──
 *
 * Nothing about presence is stored. `presence-org` membership is the answer, and
 * Pusher maintains it — which is why closing a laptop eventually marks someone
 * offline without any client having to report it, and why a heartbeat table would
 * only be a second, lagging copy of something already authoritative.
 *
 * Two consequences worth naming:
 *
 *   - `pusher:subscription_succeeded` carries the COMPLETE member list, so
 *     presence self-heals on reconnect with no catch-up endpoint. It is the one
 *     realtime feature here that needs no replay path.
 *
 *   - A person with three tabs appears ONCE. Pusher de-duplicates by the
 *     `user_id` the auth endpoint returned, which is `auth_users.id`. That is a
 *     concrete reason presence keys on the login rather than the directory
 *     person (ADR-007).
 *
 * ⚠ Presence channels cap at roughly 100 members. Fine for one QA team; the
 * failure mode past that is a silently rejected subscription rather than an
 * error, so it is logged below to be findable.
 */

interface PresenceValue {
  /** auth_users ids currently connected. Empty when realtime is off. */
  online: Set<string>;
  /** False when Pusher is not configured, so the UI can hide dots rather than
   *  showing everybody as offline — which would be a lie, not a default. */
  tracking: boolean;
}

const PresenceContext = createContext<PresenceValue>({ online: new Set(), tracking: false });

export function usePresence(): PresenceValue {
  return useContext(PresenceContext);
}

/** True when this person is online. Null means "presence is not being tracked",
 *  which the Avatar renders as no dot at all. */
export function useIsOnline(userId: string | null | undefined): boolean | undefined {
  const { online, tracking } = usePresence();
  if (!tracking || !userId) return undefined;
  return online.has(userId);
}

interface PresenceMember {
  id: string;
  info?: { displayName?: string; role?: string };
}

export function PresenceProvider({
  canChat,
  children,
}: {
  /** Subscribing needs the `chat` capability, so a viewer never attempts it and
   *  never sees a 403 in their console for a feature they do not have. */
  canChat: boolean;
  children: React.ReactNode;
}) {
  const [online, setOnline] = useState<Set<string>>(new Set());
  const enabled = realtimeEnabled() && canChat;

  useEffect(() => {
    if (!enabled) return;

    const pusher = getPusher();
    if (!pusher) return;

    const channel = pusher.subscribe(ORG_PRESENCE_CHANNEL);

    const onSubscribed = (data: { members: Record<string, unknown>; count: number }) => {
      setOnline(new Set(Object.keys(data.members)));
      if (data.count >= 90) {
        console.warn(
          `[presence] ${data.count} members — presence channels cap around 100. ` +
            "Past that, subscriptions start failing silently.",
        );
      }
    };
    const onJoin = (member: PresenceMember) =>
      setOnline((prev) => (prev.has(member.id) ? prev : new Set(prev).add(member.id)));
    const onLeave = (member: PresenceMember) =>
      setOnline((prev) => {
        if (!prev.has(member.id)) return prev;
        const next = new Set(prev);
        next.delete(member.id);
        return next;
      });
    const onError = (err: unknown) => {
      // A viewer without `chat` is refused by design; anything else is worth
      // seeing rather than silently having no dots.
      console.warn("[presence] subscription failed:", err);
      setOnline(new Set());
    };

    channel.bind("pusher:subscription_succeeded", onSubscribed);
    channel.bind("pusher:member_added", onJoin);
    channel.bind("pusher:member_removed", onLeave);
    channel.bind("pusher:subscription_error", onError);

    return () => {
      channel.unbind("pusher:subscription_succeeded", onSubscribed);
      channel.unbind("pusher:member_added", onJoin);
      channel.unbind("pusher:member_removed", onLeave);
      channel.unbind("pusher:subscription_error", onError);
      pusher.unsubscribe(ORG_PRESENCE_CHANNEL);
    };
  }, [enabled]);

  const value = useMemo(() => ({ online, tracking: enabled }), [online, enabled]);

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
