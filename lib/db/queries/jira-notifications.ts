import { sql, withTransaction } from "@/lib/db/client";

export interface JiraStoredNotification {
  id: number;
  kind: "assigned" | "status-changed" | "conflict";
  ticketId: string;
  title: string;
  body: string;
  href: string;
  createdAt: string;
}

export interface JiraNewNotification extends Omit<JiraStoredNotification, "id" | "createdAt"> {
  authUserId: string;
}

export async function createJiraNotifications(
  notifications: readonly JiraNewNotification[],
): Promise<string[]> {
  if (!notifications.length) return [];

  await withTransaction(async (client) => {
    for (const notification of notifications) {
      await client.query(
        `INSERT INTO jira_notifications (auth_user_id, kind, ticket_id, title, body, href)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          notification.authUserId,
          notification.kind,
          notification.ticketId,
          notification.title,
          notification.body,
          notification.href,
        ],
      );
    }
  });

  return [...new Set(notifications.map((notification) => notification.authUserId))];
}

/** Reads pending alerts without consuming them; the browser acknowledges after rendering. */
export async function pendingJiraNotifications(
  auth_user_id: string,
): Promise<JiraStoredNotification[]> {
  const rows = (await sql`
    SELECT id, kind, ticket_id, title, body, href, created_at
      FROM jira_notifications
     WHERE auth_user_id = ${auth_user_id} AND delivered_at IS NULL
     ORDER BY created_at ASC
     LIMIT 20
  `) as {
    id: number;
    kind: JiraStoredNotification["kind"];
    ticket_id: string;
    title: string;
    body: string;
    href: string;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    ticketId: row.ticket_id,
    title: row.title,
    body: row.body,
    href: row.href,
    createdAt: row.created_at,
  }));
}

export async function markJiraNotificationsDelivered(
  auth_user_id: string,
  notification_ids: readonly number[],
): Promise<void> {
  if (!notification_ids.length) return;
  await sql`
    UPDATE jira_notifications
       SET delivered_at = now()
     WHERE auth_user_id = ${auth_user_id}
       AND id = ANY(${notification_ids}::bigint[])
  `;
}

/** Keeps the notification table bounded without affecting undelivered alerts. */
export async function pruneJiraNotifications(): Promise<void> {
  await sql`
    DELETE FROM jira_notifications
     WHERE delivered_at IS NOT NULL
       AND delivered_at < now() - interval '30 days'
  `;
}
