import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import {
  jiraNotificationHistory,
  markJiraNotificationsDelivered,
  markJiraNotificationsRead,
  pendingJiraNotifications,
} from "@/lib/db/queries/jira-notifications";

export const runtime = "nodejs";

export const GET = withApi(async () => {
  const user = await requireUser("view");
  const [notifications, history] = await Promise.all([
    pendingJiraNotifications(user.id),
    jiraNotificationHistory(user.id),
  ]);
  return Response.json({ ok: true, notifications, history });
});

export const POST = withApi(async (request) => {
  const user = await requireUser("view");
  const body = await readJson<{ action?: unknown; ids?: unknown }>(request);
  const action = body.action ?? "delivered";
  if (!Array.isArray(body.ids) || body.ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    throw new HttpError(400, "Notification ids must be positive integers.");
  }

  const notification_ids = body.ids.map(Number);
  if (action === "delivered") await markJiraNotificationsDelivered(user.id, notification_ids);
  else if (action === "read") await markJiraNotificationsRead(user.id, notification_ids);
  else throw new HttpError(400, "Unknown notification action.");

  return Response.json({ ok: true });
});

export const PUT = withApi(async () => {
  const user = await requireUser("view");
  await markJiraNotificationsRead(user.id);
  return Response.json({ ok: true });
});
