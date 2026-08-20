import { requireUser, withApi } from "@/lib/auth/require";
import { describeJiraConfig } from "@/lib/jira/client";

export const runtime = "nodejs";

/**
 * Whether Jira is configured, and which site and account it points at.
 *
 * Never the token — not even masked, and not even to somebody with `configure`.
 * There is nothing a UI can usefully do with it, and the only way to be certain
 * it cannot leak is for it never to be in a response body.
 *
 * There is no POST counterpart. Credentials are environment variables now, so
 * changing them is a deployment action rather than a form submission. The
 * settings page shows them read-only, which is what the legacy README already
 * described for deployments.
 */
export const GET = withApi(async () => {
  await requireUser("view");
  return Response.json({ ok: true, ...describeJiraConfig() });
});
