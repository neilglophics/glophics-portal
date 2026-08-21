import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import {
  markJiraNotificationsDelivered,
  pendingJiraNotifications,
} from "@/lib/db/queries/jira-notifications";

export const runtime = "nodejs";

export const GET = withApi(async () => {
  const user = await requireUser("view");
  const notifications = await pendingJiraNotifications(user.id);
  return Response.json({ ok: true, notifications });
});

export const POST = withApi(async (request) => {
  const user = await requireUser("view");
  const body = await readJson<{ ids?: unknown }>(request);
  if (!Array.isArray(body.ids) ||
      body.ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    throw new HttpError(400, "Notification ids must be positive integers.");
  }

  await markJiraNotificationsDelivered(user.id, body.ids.map(Number));
  return Response.json({ ok: true });
});
