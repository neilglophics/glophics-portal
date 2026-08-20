import { requireUser, withApi } from "@/lib/auth/require";
import { getAvatar } from "@/lib/db/queries/avatars";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves one avatar.
 *
 * ── Behind the session gate on purpose ──
 *
 * These are photographs of colleagues on an internal board. Serving them to
 * anyone who guesses a uuid would make them public in every way that matters, so
 * this needs a session like every other route. That is also the reason the bytes
 * live in Postgres rather than in Blob: a Blob URL is a capability that cannot be
 * withdrawn, whereas this can check who is asking (docs/06 Q6).
 *
 * ── Caching ──
 *
 * `immutable` with a long max-age is safe because the URL carries `?v=<updated
 * timestamp>`: a new upload produces a different URL, so the old one being cached
 * forever is exactly what we want. `private` keeps it out of any shared cache,
 * since the response is only authorised for this viewer.
 *
 * An ETag is still sent so a client that ignores the version parameter — or one
 * revalidating after `immutable` expires — gets a 304 instead of the bytes.
 */
export const GET = withApi(async (req: Request, ctx: { params: Promise<{ userId: string }> }) => {
  // Any signed-in role may see a face; there is no separate capability for it.
  await requireUser("view");

  const { userId } = await ctx.params;
  if (!UUID.test(userId)) {
    return new Response("Not found", { status: 404 });
  }

  const avatar = await getAvatar(userId);
  if (!avatar) {
    // 404 rather than a placeholder image: the caller renders initials, and
    // serving a generated fallback here would hide "has no avatar" behind a
    // successful-looking response.
    return new Response("Not found", { status: 404 });
  }

  const etag = `"${userId}-${Date.parse(avatar.updatedAt)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(new Uint8Array(avatar.bytes), {
    status: 200,
    headers: {
      "Content-Type": avatar.mime,
      "Content-Length": String(avatar.bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      // It is an image, and nothing should be tempted to sniff it into anything
      // else. The global nosniff header covers this too; being explicit on a
      // route that returns user-supplied bytes costs nothing.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});
