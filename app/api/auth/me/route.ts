import { withApi } from "@/lib/auth/require";
import { getCurrentUser } from "@/lib/auth/session";
import { AUTH_ROLES } from "@/lib/shared/roles";

export const runtime = "nodejs";

/**
 * Answers 200 either way — "not signed in" is the expected first answer on a
 * cold load, not an error worth logging in the browser console.
 */
export const GET = withApi(async () => {
  const user = await getCurrentUser();
  return Response.json({ ok: !!user, user, roles: AUTH_ROLES });
});
