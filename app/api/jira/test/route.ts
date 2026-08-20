import { requireUser, withApi } from "@/lib/auth/require";
import { testConnection } from "@/lib/jira/client";

export const runtime = "nodejs";

/** Verifies the credentials against /myself without touching any issue. */
export const POST = withApi(async () => {
  await requireUser("configure");
  return Response.json(await testConnection());
});
