import { HttpError, requireUser, withApi } from "@/lib/auth/require";
import { lookupIssue } from "@/lib/jira/client";

export const runtime = "nodejs";

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * One ticket by key, for the Assign form's autofill.
 *
 * The key is validated against the Jira key shape before being used. It goes into
 * a URL path, so anything else is either a typo or an attempt to make this fetch
 * something it should not.
 */
export const GET = withApi(async (_req: Request, ctx: { params: Promise<{ key: string }> }) => {
  await requireUser("view");

  const { key } = await ctx.params;
  const ticket = decodeURIComponent(key).toUpperCase();

  if (!JIRA_KEY.test(ticket)) throw new HttpError(400, "That doesn't look like a Jira key.");

  const issue = await lookupIssue(ticket);
  if (!issue) throw new HttpError(404, `Jira has no ${ticket}, or the integration is not configured.`);

  return Response.json({ ok: true, issue });
});
