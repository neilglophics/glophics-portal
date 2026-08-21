"use client";

import { useCallback, useEffect } from "react";
import { useToast } from "@/components/ui/Toaster";
import { userChannel } from "@/lib/realtime/channels";
import { getPusher } from "@/lib/realtime/client";

interface JiraNotification {
  id: number;
  kind: "assigned" | "status-changed" | "conflict";
  ticketId: string;
  title: string;
  body: string;
  href: string;
}

export function JiraNotificationProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const toast = useToast();

  const fetchNotifications = useCallback(async () => {
    try {
      const response = await fetch("/api/jira/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as {
        ok: boolean;
        notifications?: JiraNotification[];
      };

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
    }
  }, [toast]);

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

  return children;
}
