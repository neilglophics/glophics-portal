"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { userChannel } from "@/lib/realtime/channels";
import { getPusher } from "@/lib/realtime/client";
import { useToast } from "@/components/ui/Toaster";
import { playNotificationSound, unlockSound } from "@/lib/notify/sound";
import { showDesktopNotification } from "@/lib/notify/desktop";
import type { UserEvents } from "@/lib/realtime/events";

/**
 * The live unread count, and the decision about whether to interrupt somebody.
 *
 * ── Why the badge is client state and not a server render ──
 *
 * Everything else in this app repaints from Postgres via router.refresh(), and
 * that is right for a table. It is wrong for a badge: a refresh is a server round
 * trip and a whole-tree re-render to change one number that the event already
 * carried. So `unread.changed` sets it directly, seeded once from the server so
 * the first paint and a reload are both correct.
 *
 * ── When a toast is warranted ──
 *
 * Only when the person cannot already see the message. Three conditions, and all
 * of them have to hold:
 *
 *   - they are not looking at that conversation, AND
 *   - the tab is actually visible, AND
 *   - the message is not their own (the server already excludes senders)
 *
 * Reading a thread while it toasts at you about the thread you are reading is
 * the single most obvious way to get this wrong.
 *
 * The tab title also carries the count, because the case this feature exists for
 * is a tab that is not in front — a toast nobody is looking at helps nobody.
 */

/**
 * What has happened in a conversation since the server rendered the list.
 *
 * The conversation list merges these over the server's rows to decide order and
 * what the preview says — see ConversationList. Held here rather than in the list
 * so it survives navigating between conversations, which remounts the list but not
 * this provider.
 */
export interface ConversationActivity {
  lastMessageAt: string;
  preview: string;
  senderName: string | null;
  unreadCount: number;
  /**
   * A local, monotonically increasing arrival number.
   *
   * The tiebreak when two messages share a timestamp — which happens when two
   * people send at once, and would otherwise leave the order of the top two
   * conversations up to object key order. A sort has to be total, or the list
   * flickers between renders.
   */
  seq: number;
}

interface UnreadValue {
  /** Across every conversation. What the nav badge shows. */
  total: number;
  /** Per conversation, for the list. Only holds what has arrived live. */
  byConversation: Record<string, number>;
  /** Live ordering and preview data, keyed by conversation. */
  activity: Record<string, ConversationActivity>;
  /** Called when a conversation is opened or read, to clear it locally without
   *  waiting for the server to confirm. */
  clear: (conversationId: string) => void;
  /**
   * The sender's OWN tab bumping its conversation to the top.
   *
   * Needed because a sender is excluded from its own Pusher fan-out by socket id,
   * so the event that reorders everybody else's list never reaches the tab that
   * sent the message. Without this, sending a message moves the conversation to
   * the top for every person in it except the one who wrote it — which is the one
   * person guaranteed to be looking.
   */
  bump: (input: { conversationId: string; preview: string; at?: string }) => void;
}

const UnreadContext = createContext<UnreadValue>({
  total: 0,
  byConversation: {},
  activity: {},
  clear: () => {},
  bump: () => {},
});

export function useUnread(): UnreadValue {
  return useContext(UnreadContext);
}

export function UnreadProvider({
  userId,
  initialTotal,
  canChat,
  children,
}: {
  userId: string;
  initialTotal: number;
  canChat: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const toast = useToast();

  const [total, setTotal] = useState(initialTotal);
  const [byConversation, setByConversation] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<Record<string, ConversationActivity>>({});

  /** Arrival order, for breaking timestamp ties. A ref, not state: bumping it must
   *  not itself cause a render. */
  const nextSeq = useRef(1);

  /** The current per-conversation counts, readable from a callback that must not
   *  depend on them. `clear` has to stay identity-stable — it sits in Thread's
   *  read effect's dependency array, and an identity that changed on every
   *  incoming message would re-arm that timer forever. */
  const byConversationRef = useRef(byConversation);
  byConversationRef.current = byConversation;

  // Read inside the event handler, which is registered once — a ref keeps it
  // current without re-subscribing on every navigation.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // A reload, or a server refresh, is authoritative again.
  useEffect(() => {
    setTotal(initialTotal);
  }, [initialTotal]);

  /**
   * An AudioContext may only be started from a user gesture, so the first click
   * or key anywhere in the app unlocks it. { once: true } because one is enough,
   * and capture so a handler that stops propagation cannot swallow it.
   */
  useEffect(() => {
    const unlock = () => unlockSound();
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (!canChat) return;
    const pusher = getPusher();
    if (!pusher) return;

    const channel = pusher.subscribe(userChannel(userId));

    const onUnread = (data: UserEvents["unread.changed"]) => {
      setTotal(data.totalUnread);
      setByConversation((prev) => ({ ...prev, [data.conversationId]: data.unreadCount }));

      // ── Ordering first, and unconditionally ──
      //
      // Recorded before any of the "should we interrupt them" checks below,
      // because reordering is not an interruption. This event now reaches muted
      // members and the sender's own other tabs precisely so their lists move
      // too; returning early for them — as this handler used to, by never being
      // sent — is what left a muted thread sitting stale halfway down the list.
      setActivity((prev) => ({
        ...prev,
        [data.conversationId]: {
          lastMessageAt: data.lastMessageAt,
          preview: data.preview,
          senderName: data.senderName,
          unreadCount: data.unreadCount,
          seq: nextSeq.current++,
        },
      }));

      // Their own message, echoed to another of their tabs. The list moves; they
      // are obviously not told about what they just wrote.
      if (data.ownMessage) return;

      // Muted: they asked not to be interrupted. The conversation still rose to
      // the top above — mute means "don't interrupt me", not "don't tell me it
      // happened". A mention overrides it, which is the whole point of being
      // mentioned in a busy group.
      if (data.muted && !data.mentioned) return;

      const viewing = pathRef.current === `/chat/${data.conversationId}`;
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";

      // Already on the thread and looking at it — the message is on screen.
      if (viewing && !hidden) return;

      // Same condition as the toast, deliberately: if it is not worth
      // interrupting them visually, it is not worth interrupting them audibly.
      // Throttled and muteable inside playNotificationSound.
      playNotificationSound();

      const author =
        data.senderName && data.conversationTitle !== data.senderName
          ? `${data.senderName}: `
          : "";

      /**
       * An OS-level notification, but only when the tab is not in front.
       *
       * A stricter condition than the toast's on purpose. The toast is inside the
       * page and costs nothing if it is not needed; a desktop notification puts
       * this app over whatever somebody is doing. Raising one while they are
       * looking at the app — which already toasted — would be telling them twice.
       *
       * No-ops unless they turned it on and the browser granted permission. Note
       * this only works while a tab is open; see lib/notify/desktop.ts for why
       * notifying a closed site is a different feature.
       */
      if (hidden) {
        showDesktopNotification({
          title: data.mentioned
            ? `${data.conversationTitle} — mentioned you`
            : data.conversationTitle,
          body: `${author}${data.preview}`,
          conversationId: data.conversationId,
          href: `/chat/${data.conversationId}`,
        });
      }

      toast.show({
        key: data.conversationId,
        // A mention says so in the title. In a group somebody is only half
        // watching, "mentioned you" is the difference between a message they read
        // now and one they find tomorrow.
        title: data.mentioned
          ? `${data.conversationTitle} — mentioned you`
          : data.conversationTitle,
        // For a group, whose message it is matters as much as what it says.
        body: `${author}${data.preview}`,
        href: `/chat/${data.conversationId}`,
        count: data.unreadCount,
      });
    };

    channel.bind("unread.changed", onUnread);
    return () => {
      channel.unbind("unread.changed", onUnread);
      // Not unsubscribed: PusherProvider owns this channel's lifetime and also
      // listens on it for session.revoked. Unsubscribing here would take that
      // with it.
    };
  }, [canChat, userId, toast]);

  /**
   * The count in the tab title.
   *
   * Restores the original on cleanup rather than assuming — the title is set
   * per-page by Next's metadata, so overwriting it permanently would leave the
   * count stuck on after the badge cleared.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = total > 0 ? `(${total}) ${base}` : base;
  }, [total, pathname]);

  /**
   * The sender's own bump.
   *
   * `Date.now()` rather than a server timestamp, because the real one only arrives
   * with the POST response and the list should move the instant Send is pressed.
   * The server's value replaces this on the next render — and a few milliseconds
   * of clock skew cannot reorder anything, since this conversation is going to the
   * top either way.
   */
  const bump = useCallback(
    ({ conversationId, preview, at }: { conversationId: string; preview: string; at?: string }) => {
      setActivity((prev) => ({
        ...prev,
        [conversationId]: {
          lastMessageAt: at ?? new Date().toISOString(),
          preview,
          // Null: the list shows no "You:" prefix on your own conversation
          // preview, matching what the server renders.
          senderName: null,
          // Sending is reading. Your own message must not light up your own badge.
          unreadCount: 0,
          seq: nextSeq.current++,
        },
      }));
    },
    [],
  );

  /**
   * A conversation has been read. Drop its badge locally.
   *
   * ── Why this records a ZERO rather than deleting the entry ──
   *
   * The list reads `byConversation[id] ?? conversation.unreadCount`, so a missing
   * entry falls back to whatever the SERVER last rendered. Deleting the entry
   * therefore un-read the conversation again, and the race is routine rather than
   * exotic:
   *
   *   1. a message arrives while you are reading the thread
   *   2. `unread.changed` sets the live count to 1 — and PusherProvider schedules
   *      a `router.refresh()`
   *   3. the server re-renders BEFORE the read POST fires (it is on a 600 ms
   *      debounce), so `conversation.unreadCount` is now 1 as well
   *   4. the read fires and deletes the live entry
   *   5. the fallback finds the server's stale 1 and the badge comes back
   *
   * An explicit 0 wins over the fallback and the badge stays gone. The server
   * catches up on the next render, and Thread asks for one as soon as the read is
   * persisted — so this local zero only has to bridge one round trip.
   *
   * `useCallback` with no dependencies matters too: this is in the dependency
   * array of Thread's read effect, and an identity that changed on every incoming
   * message would re-arm that 600 ms timer over and over, so a busy conversation
   * would never get around to reporting itself read.
   */
  const clear = useCallback((conversationId: string) => {
    // ── The subtraction happens OUTSIDE the other updater ──
    //
    // `setTotal` used to be called from inside the `setByConversation` callback.
    // State updaters must be pure, and `reactStrictMode` invokes them twice — so
    // the nav badge lost the count twice for one read and drifted below the truth.
    // Same mistake as the one that uploaded every file twice; it is subtle
    // precisely because the visible symptom is a number that is merely wrong
    // rather than an obvious crash.
    //
    // Only what we already know about is subtracted. When the count came from the
    // server rather than a live event there is nothing here to subtract, and the
    // refresh Thread triggers after the read POST is what corrects the total.
    setByConversation((prev) => {
      if (prev[conversationId] === 0) return prev;
      return { ...prev, [conversationId]: 0 };
    });
    setTotal((t) => Math.max(0, t - (byConversationRef.current[conversationId] ?? 0)));

    setActivity((prev) => {
      const current = prev[conversationId];
      if (!current || current.unreadCount === 0) return prev;
      return { ...prev, [conversationId]: { ...current, unreadCount: 0 } };
    });
  }, []);

  const value = useMemo<UnreadValue>(
    () => ({
      total,
      byConversation,
      activity,
      bump,
      clear,
    }),
    [total, byConversation, activity, bump, clear],
  );

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
