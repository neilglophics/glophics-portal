import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { updateSettings } from "@/lib/db/queries/config";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";
import type { JiraSettings, OnExpiry } from "@/lib/types";

export const runtime = "nodejs";

interface Body {
  defaultBookingHours?: number;
  onExpiry?: OnExpiry;
  assignWholeEnv?: boolean;
  jira?: Partial<JiraSettings>;
}

/**
 * Booking defaults, expiry behaviour, and the Jira status rules.
 *
 * The `jira` block is merged into the stored jsonb rather than replacing it, so a
 * form that only sends `{ enabled: true }` cannot wipe the status lists.
 *
 * Jira *credentials* are not here. They live in environment variables and never
 * come back to the client — the settings page shows them read-only, which is
 * what the legacy README already described for deployments.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("configure");

  const body = await readJson<Body>(req);
  const result = await updateSettings({
    ...(body.defaultBookingHours !== undefined
      ? { defaultBookingHours: Number(body.defaultBookingHours) }
      : {}),
    ...(body.onExpiry !== undefined ? { onExpiry: body.onExpiry } : {}),
    ...(body.assignWholeEnv !== undefined ? { assignWholeEnv: !!body.assignWholeEnv } : {}),
    ...(body.jira !== undefined ? { jira: body.jira } : {}),
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("settings.changed", {}, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true });
});
