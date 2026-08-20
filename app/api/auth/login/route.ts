import { withApi, readJson } from "@/lib/auth/require";
import { createSession } from "@/lib/auth/session";
import { seedFirstSuperAdmin, verifySignIn } from "@/lib/db/queries/auth";
import { clientIp } from "@/lib/ip-allowlist";

/** scrypt needs node:crypto, so this cannot run on Edge. */
export const runtime = "nodejs";

/**
 * The sign-in handshake. Public — this is how you get a session.
 *
 * On a completely empty credential table it seeds the first super admin from
 * ADMIN_USERNAME / ADMIN_PASSWORD, then falls through to the normal verify. The
 * legacy app did this at boot and printed the password to the console; there is
 * no boot here, so it happens on the first sign-in attempt instead and requires
 * the password to have been set deliberately.
 */
export const POST = withApi(async (req: Request) => {
  const { username, password } = await readJson<{ username?: string; password?: string }>(req);

  try {
    await seedFirstSuperAdmin();
  } catch (err) {
    // A misconfigured first run should say so plainly rather than looking like a
    // wrong password forever.
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  const result = await verifySignIn(username, password);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 401 });
  }

  await createSession(result.userId, {
    userAgent: req.headers.get("user-agent") ?? undefined,
    ip: clientIp(req.headers) ?? undefined,
  });

  return Response.json({ ok: true });
});
