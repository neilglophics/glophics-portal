import { requireUser, withApi } from "@/lib/auth/require";
import { previewImageUrl } from "@/lib/db/queries/link-previews";
import { assertFetchableUrl } from "@/lib/link-preview/fetch";
import { safeHref } from "@/lib/chat/links";

export const runtime = "nodejs";

/** What a preview thumbnail is allowed to be. Anything else is not an image, and
 *  in particular SVG is a script container — the same reason it is excluded from
 *  attachments. */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** A preview thumbnail is small. Anything larger is not a thumbnail and is not
 *  worth streaming through our function. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 5000;

/**
 * Serves a link preview's image, fetched by us rather than by the browser.
 *
 * ── Why proxy at all ──
 *
 * The obvious implementation puts the remote `og:image` straight into an `<img
 * src>`. That would tell the image's host the IP address, the time and the user
 * agent of **every person who reads the conversation** — a read receipt for a
 * third party, triggered by anybody who can paste a link. Somebody wanting to know
 * when a particular team looks at a particular message would only have to send one.
 *
 * So the URL never reaches a browser. It is stored, looked up here by the page URL
 * it belongs to, and fetched server-side.
 *
 * ── The `url` parameter is a cache key, not a destination ──
 *
 * This is the property that keeps the endpoint from being an open proxy. The
 * caller passes the *page* URL; the image URL comes from our own database, having
 * already been through `parseMetadata`. There is no input here that can name an
 * arbitrary host — asking for a page we have never previewed simply 404s. The
 * SSRF guard still runs on the stored value, because a page we previewed a week
 * ago could have advertised an image on a host that has since become internal.
 */
export const GET = withApi(async (req: Request) => {
  await requireUser("chat");

  const requested = new URL(req.url).searchParams.get("url") ?? "";
  const pageUrl = safeHref(requested);
  if (!pageUrl) return new Response("Not found", { status: 404 });

  // From our own cache, never from the request.
  const imageUrl = await previewImageUrl(pageUrl);
  if (!imageUrl) return new Response("Not found", { status: 404 });

  const checked = await assertFetchableUrl(imageUrl);
  if ("error" in checked) return new Response("Not found", { status: 404 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(checked.url, {
      // Manual, like the metadata fetch: a redirect could otherwise land on an
      // address the guard just refused.
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "image/*" },
    }).catch(() => null);

    if (!upstream || !upstream.ok) {
      await upstream?.body?.cancel().catch(() => {});
      return new Response("Not found", { status: 404 });
    }

    const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      await upstream.body?.cancel().catch(() => {});
      return new Response("Not found", { status: 404 });
    }

    const declared = Number(upstream.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      return new Response("Not found", { status: 404 });
    }

    // Buffered rather than streamed, unlike attachments. A thumbnail is small, and
    // buffering is what lets the size cap be *enforced* rather than merely
    // declared — Content-Length is a claim, and a hostile host can lie about it.
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        // `private`, because it is only authorised for this viewer. A day rather
        // than a year: unlike an attachment, the bytes behind this URL can change
        // under us, and there is no version parameter to bust.
        "Cache-Control": "private, max-age=86400",
        // It came from somewhere we do not control. Nothing should sniff it into
        // anything other than the image type we checked.
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } finally {
    clearTimeout(timer);
  }
});
