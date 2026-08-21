-- 0006_link_previews — cached Open Graph metadata for links pasted into chat.
--
-- Clickable links need no schema at all: they are a rendering decision, made in
-- lib/chat/links.ts from the message body that is already stored. This table is
-- only for the *card* under the link — the title, description and image a site
-- advertises about itself.
--
-- ── Why a cache table and not a column on chat_messages ──
--
-- Keyed by URL, not by message, so:
--
--   - the same link pasted in five conversations is fetched once, not five times;
--   - an old message gets a card the first time anybody scrolls past it, without
--     a backfill;
--   - a failure is remembered. Without a row for "this one does not work", every
--     render of a message containing a dead link re-fetches it, which turns one
--     broken URL into a permanent outbound request loop.
--
-- ── The url is the primary key, and it is normalised before it gets here ──
--
-- `lib/chat/links.ts safeHref()` parses and re-serialises every URL, so the key is
-- a canonical form rather than whatever somebody typed. Bounded at 2048 because a
-- primary key on unbounded user input is a way to blow up an index with one paste.
CREATE TABLE chat_link_previews (
  url          text        PRIMARY KEY,

  -- ── All of these are nullable, including on success ──
  --
  -- A page is under no obligation to have an og:title, and plenty do not. A row
  -- with a null title and status 'ok' means "we looked, there was nothing worth
  -- showing" — which is different from "we have not looked yet" (no row) and from
  -- "we looked and it failed" (status 'error'). Those three states are why this
  -- table has a status column rather than just nullable metadata.
  title        text,
  description  text,
  site_name    text,
  -- The image's own URL, as advertised. NEVER given to a browser directly: it is
  -- fetched through /api/chat/link-preview/image so a third-party host cannot see
  -- who is reading a conversation or when. See the note in lib/link-preview/fetch.ts.
  image_url    text,

  status       text        NOT NULL,
  -- Why it failed, for a human reading the table. Never shown to a user — a
  -- preview that fails simply does not render, because "couldn't reach
  -- example.com" is noise attached to a link that is probably fine.
  error        text,

  fetched_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_link_previews_status_valid CHECK (status IN ('ok', 'error')),
  CONSTRAINT chat_link_previews_url_bounded  CHECK (length(url) BETWEEN 1 AND 2048),

  -- Bounds on what gets stored, so one hostile page cannot put a megabyte of
  -- <meta content> into this table. The fetcher truncates first; this is the
  -- backstop for a fetcher that stopped truncating.
  CONSTRAINT chat_link_previews_sane_lengths CHECK (
    (title       IS NULL OR length(title)       <= 300)  AND
    (description IS NULL OR length(description) <= 1000) AND
    (site_name   IS NULL OR length(site_name)   <= 120)  AND
    (image_url   IS NULL OR length(image_url)   <= 2048)
  )
);

-- Refetching: a card cached a year ago may describe a page that has changed, and
-- a failure from a minute ago should not be retried on every render. Both are
-- answered by age, so this is the only index the sweep and the read path need.
CREATE INDEX chat_link_previews_fetched_idx ON chat_link_previews (fetched_at);
