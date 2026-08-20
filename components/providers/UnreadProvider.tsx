"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { userChannel } from "@/lib/realtime/channels";
import { getPusher } from "@/lib/realtime/client";
import { useToast } from "@/components/ui/Toaster";
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

interface UnreadValue {
  /** Across every conversation. What the nav badge shows. */
  total: number;
  /** Per conversation, for the list. Only holds what has arrived live. */
  byConversation: Record<string, number>;
  /** Called when a conversation is opened or read, to clear it locally without
   *  waiting for the server to confirm. */
  clear: (conversationId: string) => void;
}

const UnreadContext = createContext<UnreadValue>({
  total: 0,
  byConversation: {},
  clear: () => {},
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

  // Read inside the event handler, which is registered once — a ref keeps it
  // current without re-subscribing on every navigation.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // A reload, or a server refresh, is authoritative again.
  useEffect(() => {
    setTotal(initialTotal);
  }, [initialTotal]);

  useEffect(() => {
    if (!canChat) return;
    const pusher = getPusher();
    if (!pusher) return;

    const channel = pusher.subscribe(userChannel(userId));

    const onUnread = (data: UserEvents["unread.changed"]) => {
      setTotal(data.totalUnread);
      setByConversation((prev) => ({ ...prev, [data.conversationId]: data.unreadCount }));

      const viewing = pathRef.current === `/chat/${data.conversationId}`;
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";

      // Already on the thread and looking at it — the message is on screen.
      if (viewing && !hidden) return;

      toast.show({
        key: data.conversationId,
        title: data.conversationTitle,
        // For a group, whose message it is matters as much as what it says.
        body: data.senderName && data.conversationTitle !== data.senderName
          ? `${data.senderName}: ${data.preview}`
          : data.preview,
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

  const value = useMemo<UnreadValue>(
    () => ({
      total,
      byConversation,
      clear: (conversationId: string) => {
        setByConversation((prev) => {
          const had = prev[conversationId] ?? 0;
          if (!had) return prev;
          // Drop this conversation's share of the total rather than refetching:
          // the server will confirm on the next render either way.
          setTotal((t) => Math.max(0, t - had));
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
      },
    }),
    [total, byConversation],
  );

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
