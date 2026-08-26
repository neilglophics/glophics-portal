/**
 * Finding links in message text, and deciding which ones may be rendered.
 *
 * ── This file exists so that nothing has to reach for innerHTML ──
 *
 * The rule at the top of the Bubble component, and invariant 7 in CLAUDE.md, is
 * that everything a user types is escaped: chat is the whole XSS surface of this
 * app, and `dangerouslySetInnerHTML` is not on the table. Turning text into links
 * is the exact request that usually breaks that rule.
 *
 * So this module does NOT produce HTML. It **splits a string into segments** —
 * plain text and links — and the component renders each as a React child, where
 * React escapes it as it always did. There is no path here from a message body to
 * markup.
 *
 * Pure, dependency-free, and safe to import from a client component.
 */

/**
 * Schemes that may become an anchor. Everything else renders as plain text.
 *
 * This is an allowlist because the interesting attacks are schemes, not hosts:
 * `javascript:alert(1)` in an href executes in our origin, and `data:text/html,…`
 * renders attacker HTML there. A denylist of "javascript" is also trivially
 * bypassed — `java\tscript:` and `JaVaScRiPt:` are both live in some parsers,
 * which is why the check below is done on a parsed URL's protocol rather than on
 * the raw string.
 */
const RENDERABLE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Matches a URL inside prose.
 *
 * Two forms: an explicit scheme, or a bare `www.` host — because people paste both
 * and a bare `www.` link that is not clickable reads as a bug.
 *
 * The character class deliberately excludes whitespace, angle brackets, and
 * quotes. Trailing punctuation is dealt with afterwards by `trimTrailing`, not
 * here: a regex that tries to do both becomes unreadable and still gets
 * `(see https://example.com/a)` wrong.
 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/**
 * Punctuation that ends a sentence rather than a URL.
 *
 * "Check https://example.com/page." should not link the full stop, and
 * "(https://example.com)" should not link the closing bracket. Parentheses are the
 * hard case, because they occur *inside* real URLs — Wikipedia and Jira both do it
 * — so a closing bracket is only trimmed when it is unbalanced.
 */
function trimTrailing(raw: string): string {
  let url = raw;

  for (;;) {
    const last = url[url.length - 1];
    if (!last) break;

    if (".,;:!?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }

    // Only trim a closer that has no opener inside the URL, so
    // `…/Foo_(disambiguation)` survives while `(…example.com)` does not.
    if (last === ")" || last === "]" || last === "}") {
      const opener = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = url.split(opener).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return url;
}

/**
 * A URL fit to put in an `href`, or null.
 *
 * Parses rather than pattern-matches, so the protocol check happens on what a
 * browser would actually navigate to. A bare `www.` host is given `https://`,
 * which is the only reasonable guess in 2026 and the one every other client makes.
 *
 * Null means "render this as text" — never "render it with a href we are not sure
 * about".
 */
export function safeHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (!RENDERABLE_PROTOCOLS.has(parsed.protocol)) return null;
  // A URL with no host is not somewhere to go. `http:///x` parses in some engines.
  if (!parsed.hostname) return null;

  return parsed.toString();
}

export type MessageSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string };

/**
 * Splits a message body into text and links.
 *
 * The component maps over these and renders a `<a>` for links and a plain string
 * for text — so the escaping story is unchanged from when the body was one text
 * child. Every character of the input appears in exactly one segment, which is the
 * property that makes that true: nothing is dropped, nothing is duplicated, and
 * `segments(body).map(s => s.value).join("")` is the original body.
 */
export function segments(body: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  let cursor = 0;

  // A fresh regex per call: a module-level /g/ regex carries `lastIndex` between
  // calls, which makes the second render of the same string return nothing.
  const pattern = new RegExp(URL_PATTERN.source, "gi");

  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const matched = match[0];
    const url = trimTrailing(matched);
    const href = safeHref(url);

    // Not renderable — leave the regex where it is and let the text run swallow
    // it, so an unsupported scheme appears as the text somebody typed.
    if (!href) continue;

    const start = match.index;

    if (start > cursor) {
      out.push({ kind: "text", value: body.slice(cursor, start) });
    }
    out.push({ kind: "link", value: url, href });
    cursor = start + url.length;

    // Rewound, because trimTrailing may have given characters back — the full stop
    // after a URL has to be picked up by the next text run.
    pattern.lastIndex = cursor;
  }

  if (cursor < body.length) {
    out.push({ kind: "text", value: body.slice(cursor) });
  }

  return out;
}

/** Every renderable link in a body, in order, de-duplicated. */
export function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const segment of segments(body)) {
    if (segment.kind === "link") seen.add(segment.href);
  }
  return [...seen];
}

/**
 * The first link in a message — the one that gets a preview card.
 *
 * One card, not one per link. A message pasting six URLs would otherwise become a
 * wall of cards taller than the thread, and the first link is overwhelmingly the
 * one the message is about.
 */
export function previewableLink(body: string): string | null {
  return extractLinks(body)[0] ?? null;
}

/** Returns a safe YouTube embed URL, or null for every other URL shape. */
export function youtubeEmbedUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let videoId: string | null = null;

  if (hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    } else {
      const match = parsed.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/);
      videoId = match?.[1] ?? null;
    }
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * How a long URL is shown in a bubble.
 *
 * The full URL goes in the `href` and the `title`; this is only what is painted.
 * A 200-character tracking URL wrapping over four lines pushes the message it
 * belongs to off the screen, and nobody reads the query string anyway.
 */
export function linkLabel(href: string, max = 60): string {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return href.slice(0, max);
  }

  // The scheme is noise in a chat bubble; the host never is.
  const shown = parsed.hostname.replace(/^www\./i, "") + parsed.pathname + parsed.search;
  const trimmed = shown.replace(/\/$/, "");

  if (trimmed.length <= max) return trimmed;
  // Truncated in the MIDDLE: the end of a URL is often the identifying part (an
  // issue key, a comment id), so cutting only the tail throws away the half that
  // tells you where it goes.
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}
