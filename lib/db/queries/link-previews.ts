/**
 * The link-preview cache.
 *
 * Keyed by URL rather than by message, so the same link pasted in five
 * conversations is fetched once and an old message gets a card the first time
 * somebody scrolls past it.
 *
 * ── Failures are cached too, and that is the important part ──
 *
 * Without a negative entry, every render of a message containing a dead link
 * re-fetches it. One broken URL in an active thread then becomes a permanent
 * outbound request loop against somebody else's server — which is both rude and a
 * good way to get our IP blocked. So an error is a row, with a shorter life than a
 * success.
 */

import { sql } from "@/lib/db/client";
import type { LinkMetadata } from "@/lib/link-preview/fetch";

/** What the client is given. No `error` — a preview that failed simply does not
 *  render, because "couldn't reach example.com" is noise attached to a link that
 *  is probably fine. */
export interface LinkPreviewView {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** True when there is an image to show. The URL itself is NOT sent: the browser
   *  asks /api/chat/link-preview/image for it, so no third-party host learns who
   *  is reading a conversation. */
  hasImage: boolean;
}

/**
 * How long a cached answer is trusted.
 *
 * A week for a success: a page's title changes rarely, and a stale title is a much
 * smaller problem than re-fetching every link on every render. An hour for a
 * failure, because "the site was down" is usually temporary and an hour is long
 * enough that a scrolling thread does not retry it.
 */
const OK_TTL_HOURS = 24 * 7;
const ERROR_TTL_HOURS = 1;

interface Row {
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
  status: "ok" | "error";
  fetched_at: string;
}

function toView(row: Row): LinkPreviewView | null {
  if (row.status !== "ok") return null;
  // A row with nothing worth showing is not a card. Rendering an empty box under a
  // link is worse than rendering nothing, and plenty of pages have no og: tags at
  // all.
  if (!row.title && !row.description && !row.image_url) return null;

  return {
    url: row.url,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    hasImage: !!row.image_url,
  };
}

/**
 * A cached preview, or null when there is nothing fresh.
 *
 * Returns `{ cached: false }` for both "never fetched" and "too old", because the
 * caller does the same thing in both cases — and distinguishing them would only
 * invite a code path that serves stale data.
 */
export async function cachedPreview(
  url: string,
): Promise<{ cached: true; preview: LinkPreviewView | null } | { cached: false }> {
  const rows = (await sql`
    SELECT url, title, description, site_name, image_url, status, fetched_at
      FROM chat_link_previews
     WHERE url = ${url}
       -- The ::int casts are load-bearing. The driver sends parameters as text,
       -- and inside a CASE there is nothing for Postgres to infer a type from —
       -- both arms are unknown — so make_interval(hours => text) is looked up and
       -- does not exist. A bare parameter elsewhere gets its type from the
       -- function signature; here it has to be told.
       AND fetched_at > now() - make_interval(hours =>
             CASE WHEN status = 'ok' THEN ${OK_TTL_HOURS}::int ELSE ${ERROR_TTL_HOURS}::int END)
  `) as Row[];

  const row = rows[0];
  return row ? { cached: true, preview: toView(row) } : { cached: false };
}

/** Stores a successful fetch. Upserts, so a refresh replaces a stale row rather
 *  than accumulating one per attempt. */
export async function storePreview(url: string, metadata: LinkMetadata): Promise<LinkPreviewView | null> {
  const rows = (await sql`
    INSERT INTO chat_link_previews (url, title, description, site_name, image_url, status, error, fetched_at)
    VALUES (${url}, ${metadata.title}, ${metadata.description}, ${metadata.siteName},
            ${metadata.imageUrl}, 'ok', NULL, now())
    ON CONFLICT (url) DO UPDATE SET
      title = EXCLUDED.title, description = EXCLUDED.description,
      site_name = EXCLUDED.site_name, image_url = EXCLUDED.image_url,
      status = 'ok', error = NULL, fetched_at = now()
    RETURNING url, title, description, site_name, image_url, status, fetched_at
  `) as Row[];

  return toView(rows[0]!);
}

/** Remembers that a URL does not work, so it is not retried on every render. */
export async function storePreviewFailure(url: string, error: string): Promise<void> {
  await sql`
    INSERT INTO chat_link_previews (url, status, error, fetched_at)
    VALUES (${url}, 'error', ${error.slice(0, 200)}, now())
    ON CONFLICT (url) DO UPDATE SET
      status = 'error', error = EXCLUDED.error, fetched_at = now(),
      -- Cleared, so a page that used to have a title and now 404s stops showing
      -- the old one. A card describing a page that has gone is worse than no card.
      title = NULL, description = NULL, site_name = NULL, image_url = NULL
  `;
}

/**
 * The stored image URL for a cached preview.
 *
 * Only ever read server-side, by the image proxy. This is the one function that
 * hands out an `image_url`, and its caller fetches it rather than forwarding it —
 * see the note at the top of lib/link-preview/fetch.ts for why a browser must
 * never see it.
 */
export async function previewImageUrl(url: string): Promise<string | null> {
  const rows = (await sql`
    SELECT image_url FROM chat_link_previews
     WHERE url = ${url} AND status = 'ok' AND image_url IS NOT NULL
  `) as { image_url: string }[];

  return rows[0]?.image_url ?? null;
}

/** Housekeeping: rows nobody is going to ask for again. Called by the retention
 *  cron, purely to stop an unbounded table. */
export async function sweepStalePreviews(olderThanDays = 60): Promise<number> {
  const rows = (await sql`
    DELETE FROM chat_link_previews
     WHERE fetched_at < now() - make_interval(days => ${olderThanDays}::int)
    RETURNING url
  `) as unknown[];
  return rows.length;
}
