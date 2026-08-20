import { withApi } from "@/lib/auth/require";
import { destroyCurrentSession } from "@/lib/auth/session";

export const runtime = "nodejs";

/** Public, like login: signing out must work even with a token the server no
 *  longer recognises, so the cookie is always cleared. */
export const POST = withApi(async () => {
  await destroyCurrentSession();
  return Response.json({ ok: true });
});
