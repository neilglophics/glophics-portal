"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toaster";
import { userChannel } from "@/lib/realtime/channels";
import { getPusher } from "@/lib/realtime/client";

export interface JiraNotification {
  id: number;
  kind: "assigned" | "status-changed" | "conflict";
  ticketId: string;
  title: string;
  body: string;
  href: string;
  createdAt: string;
  readAt?: string | null;
}

interface JiraNotificationValue {
  history: JiraNotification[];
  unread_count: number;
  loading: boolean;
  refresh: () => Promise<void>;
  markRead: (notification_id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const JiraNotificationContext = createContext<JiraNotificationValue>({
  history: [],
  unread_count: 0,
  loading: true,
  refresh: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
});

export function useJiraNotifications(): JiraNotificationValue {
  return useContext(JiraNotificationContext);
}

export function JiraNotificationProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const toast = useToast();
  const [history, setHistory] = useState<JiraNotification[]>([]);
  const [unread_count, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    try {
      const response = await fetch("/api/jira/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as {
        ok: boolean;
        notifications?: JiraNotification[];
        history?: {
          notifications: JiraNotification[];
          unreadCount: number;
        };
      };

      if (data.history) {
        setHistory(data.history.notifications);
        setUnreadCount(data.history.unreadCount);
      }

      for (const notification of data.notifications ?? []) {
        toast.show({
          key: `jira:${notification.id}`,
          title: notification.title,
          body: notification.body,
          href: notification.href,
          external: true,
        });

        const can_show_browser_notification =
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          document.visibilityState !== "visible";
        if (!can_show_browser_notification) continue;

        const browser_notification = new Notification(notification.title, {
          body: notification.body,
          tag: `jira:${notification.kind}:${notification.ticketId}`,
        });
        browser_notification.onclick = () => {
          window.open(notification.href, "_blank", "noopener,noreferrer");
          browser_notification.close();
        };
      }

      const notification_ids = (data.notifications ?? []).map((notification) => notification.id);
      if (notification_ids.length) {
        await fetch("/api/jira/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: notification_ids }),
        });
      }
    } catch {
      // A later signal, reconnect, or page load retries pending notifications.
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const markRead = useCallback(async (notification_id: number) => {
    setHistory((current_history) => current_history.map((notification) =>
      notification.id === notification_id && !notification.readAt
        ? { ...notification, readAt: new Date().toISOString() }
        : notification,
    ));
    setUnreadCount((current_count) => {
      const was_unread = history.some(
        (notification) => notification.id === notification_id && !notification.readAt,
      );
      return was_unread ? Math.max(0, current_count - 1) : current_count;
    });

    const response = await fetch("/api/jira/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", ids: [notification_id] }),
    }).catch(() => null);
    if (!response?.ok) await fetchNotifications();
  }, [history, fetchNotifications]);

  const markAllRead = useCallback(async () => {
    const read_at = new Date().toISOString();
    setHistory((current_history) => current_history.map((notification) => ({
      ...notification,
      readAt: notification.readAt ?? read_at,
    })));
    setUnreadCount(0);

    const response = await fetch("/api/jira/notifications", { method: "PUT" }).catch(() => null);
    if (!response?.ok) await fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    void fetchNotifications();

    const pusher = getPusher();
    if (!pusher) return;
    const channel = pusher.subscribe(userChannel(userId));
    const on_notification = () => void fetchNotifications();
    channel.bind("jira.notification", on_notification);
    return () => {
      channel.unbind("jira.notification", on_notification);
    };
  }, [userId, fetchNotifications]);

  const value = useMemo(() => ({
    history,
    unread_count,
    loading,
    refresh: fetchNotifications,
    markRead,
    markAllRead,
  }), [history, unread_count, loading, fetchNotifications, markRead, markAllRead]);

  return <JiraNotificationContext.Provider value={value}>{children}</JiraNotificationContext.Provider>;
}
