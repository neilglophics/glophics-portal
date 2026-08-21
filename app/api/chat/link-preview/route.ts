import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import {
  cachedPreview,
  storePreview,
  storePreviewFailure,
} from "@/lib/db/queries/link-previews";
import { fetchLinkMetadata } from "@/lib/link-preview/fetch";
import { safeHref } from "@/lib/chat/links";
import { requireWithinLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Metadata for a link, from cache or by fetching it once.
 *
 * ── POST, not GET, and not conversation-scoped ──
 *
 * POST because this can cause an outbound request, which makes it a mutation in
 * every sense that matters — and because a state-changing GET would forfeit the
 * `SameSite=Lax` protection that stands in for CSRF tokens in this app.
 *
 * It is deliberately NOT scoped to a conversation. The cache is keyed by URL, so
 * scoping would mean either a per-conversation copy of every card or a membership
 * check that does not actually protect anything: the answer is public information
 * about a public page, identical for every viewer. What the `chat` capability does
 * gate is the ability to make this server fetch things at all — which is the part
 * worth gating, and it is why a viewer-role login cannot reach this.
 *
 * ── The URL is re-validated here, not trusted ──
 *
 * `safeHref` is the same function the renderer uses to decide whether a link is
 * clickable, so a URL that could never appear as a link in a bubble cannot be used
 * to make the server fetch something either. The deeper checks — DNS, private
 * ranges, redirects — live in `fetchLinkMetadata`, which is where the SSRF guard
 * belongs because that is where the fetch happens.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser("chat");

  const body = await readJson<{ url?: string }>(req);
  const requested = String(body.url ?? "");

  // Normalised through the same gate the renderer uses. Anything else is not a
  // link as far as this app is concerned.
  const url = safeHref(requested);
  if (!url) throw new HttpError(400, "Not a link.");
  if (url.length > 2048) throw new HttpError(400, "That URL is too long.");

  // Served from cache BEFORE the rate limit is consumed. A busy thread re-asking
  // for the same handful of cards must not burn somebody's allowance, and a cache
  // hit costs one indexed lookup and no outbound traffic at all.
  const cached = await cachedPreview(url);
  if (cached.cached) {
    return Response.json({ ok: true, preview: cached.preview, cached: true });
  }

  // Only a real fetch is limited. This is the expensive, abusable path: it makes
  // our server talk to a host of the caller's choosing.
  await requireWithinLimit("chat.link.preview", user.id);

  const outcome = await fetchLinkMetadata(url);

  if (!outcome.ok) {
    // Remembered, so the next render does not try again. The reason is stored for
    // whoever reads the table and never returned to the client — a link that
    // failed simply gets no card.
    await storePreviewFailure(url, outcome.error);
    return Response.json({ ok: true, preview: null, cached: false });
  }

  const preview = await storePreview(url, outcome.metadata);
  return Response.json({ ok: true, preview, cached: false });
});
