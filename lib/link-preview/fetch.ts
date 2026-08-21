/**
 * Fetching Open Graph metadata for a URL somebody pasted into chat.
 *
 * **Server-only, and the most security-sensitive module in the app after
 * /api/pusher/auth.** Everything else here fetches things an administrator
 * configured. This fetches a URL a *user* supplied, from inside our own network,
 * which is the definition of SSRF.
 *
 * ── The threat, stated plainly ──
 *
 * If a member pastes `http://169.254.169.254/latest/meta-data/iam/…` and the
 * server fetches it and stores the response as a "description", the board becomes
 * a way to read cloud instance credentials. The same trick aimed at
 * `http://localhost:3000/api/…` reaches our own routes with whatever the platform
 * considers a local request. Neither needs the attacker to see the page — a title
 * in a card is enough to exfiltrate.
 *
 * So the guard is not a nicety. Six controls, and each one closes a hole the
 * others do not:
 *
 *   1. **Scheme allowlist.** http and https only. `file:`, `gopher:`, `ftp:` and
 *      friends do not go near a fetch.
 *   2. **DNS resolution, then an IP check.** Hostname-based blocklists are
 *      bypassed by a name that resolves to a private address — which anybody can
 *      create, and which services exist to provide. So the host is resolved here
 *      and every returned address is checked against the private ranges.
 *   3. **Redirects followed MANUALLY, re-checking each hop.** `redirect: "follow"`
 *      is the hole in most implementations of this: the first URL passes the
 *      check, the server 302s to 127.0.0.1, and fetch obligingly goes. Each hop is
 *      re-validated from scratch.
 *   4. **A byte cap on the response.** Only the <head> is wanted, so the stream is
 *      abandoned after 128 KB. An endless response would otherwise hold a function
 *      open until it timed out.
 *   5. **A timeout.** 5 seconds. A slow host must not become our slow request.
 *   6. **text/html only.** Anything else is not a page with metadata on it, and
 *      parsing it would be a waste at best.
 *
 * ── What is NOT done, deliberately ──
 *
 * The remote image is not fetched here and its URL is never handed to a browser.
 * A card rendering `<img src="https://someone-elses-host/x.jpg">` tells that host
 * the IP, the time and the user agent of everybody who reads the conversation —
 * a read receipt for a third party. The image goes through
 * /api/chat/link-preview/image, which applies this same guard.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 5000;
const MAX_BYTES = 128 * 1024;
const MAX_REDIRECTS = 3;

/**
 * A polite, honest user agent.
 *
 * Identifying ourselves rather than impersonating a browser: a site that does not
 * want to be previewed should be able to tell, and a bot that lies about what it
 * is is a bot that deserves to be blocked.
 */
const USER_AGENT = "ServerManagementBot/1.0 (+link preview; internal QA board)";

export interface LinkMetadata {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

export type FetchOutcome =
  | { ok: true; metadata: LinkMetadata }
  | { ok: false; error: string };

/**
 * Is this address one we must never fetch?
 *
 * Covers loopback, private ranges, link-local (which is where cloud metadata
 * services live — the whole point), carrier-grade NAT, and the IPv6 equivalents
 * including IPv4-mapped addresses, because `::ffff:127.0.0.1` is a loopback
 * address wearing a hat.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped: re-check the embedded v4 address rather than trusting the
    // wrapper. ::ffff:169.254.169.254 is the metadata service.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]!);

    if (lower === "::" || lower === "::1") return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Unparseable is blocked. Failing closed is the only safe default here.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast and reserved

  return false;
}

/**
 * Resolves a hostname and refuses it if ANY address is blocked.
 *
 * All addresses, not just the first: a name that resolves to both a public and a
 * private address would otherwise be a coin flip, and an attacker gets to flip it
 * as many times as they like.
 *
 * This still leaves a DNS-rebinding window — the name could resolve differently
 * between this check and the fetch — which is unavoidable without pinning the
 * socket to a checked IP, something `fetch` gives no way to do. The window is
 * narrow, the payoff is a title in a card, and the alternative is a hand-rolled
 * HTTP client. Documented rather than pretended away.
 */
async function assertHostAllowed(hostname: string): Promise<string | null> {
  // An IP typed directly needs no resolution, just checking.
  if (isIP(hostname)) {
    return isBlockedAddress(hostname) ? "That address isn't reachable." : null;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return "That host could not be resolved.";
  }

  if (!addresses.length) return "That host could not be resolved.";
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    return "That address isn't reachable.";
  }
  return null;
}

/** One hop. Returns the response, or the next URL to try. */
async function hop(
  url: URL,
  signal: AbortSignal,
): Promise<{ kind: "response"; response: Response } | { kind: "redirect"; to: string } | { kind: "error"; error: string }> {
  const blocked = await assertHostAllowed(url.hostname);
  if (blocked) return { kind: "error", error: blocked };

  let response: Response;
  try {
    response = await fetch(url, {
      // MANUAL. This is control 3, and the single most important line in the file:
      // letting fetch follow redirects would let a public URL bounce us to
      // localhost with no second check.
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        // Asking for a page, not a download.
        "Accept-Language": "en",
      },
    });
  } catch (err) {
    return { kind: "error", error: (err as Error).name === "AbortError" ? "Timed out." : "Unreachable." };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return { kind: "error", error: "Redirect with no destination." };
    // Resolved against the current URL, so a relative Location works.
    return { kind: "redirect", to: new URL(location, url).toString() };
  }

  return { kind: "response", response };
}

/**
 * Reads at most `MAX_BYTES` of a response body as text.
 *
 * Streamed and abandoned rather than `response.text()`, which would buffer
 * whatever the server chose to send. The <head> of a page is in the first few KB;
 * anything past the cap cannot contain metadata we are going to use anyway.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });

      if (total >= MAX_BYTES) break;
      // The rest of the document is irrelevant once the head is closed.
      if (text.includes("</head>")) break;
    }
  } finally {
    // Releases the socket rather than leaving it draining in the background.
    await reader.cancel().catch(() => {});
  }

  return text;
}

/** Collapses whitespace and truncates, so a card is one tidy line rather than a
 *  page's worth of indented HTML. */
function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The handful of HTML entities that actually turn up in `<meta content>`.
 *
 * Not a general-purpose decoder, and it does not need to be: this output is
 * rendered as a React text child, so anything left undecoded is displayed
 * literally rather than interpreted. The worst case of missing an entity is an
 * ugly `&hellip;` in a card, never markup.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Ampersand last, so &amp;lt; does not become <.
    .replace(/&amp;/g, "&");
}

/**
 * Pulls metadata out of HTML with regexes rather than a DOM parser.
 *
 * A real parser would be more correct and would mean a dependency plus a full
 * parse of an attacker-controlled document. What is wanted here is four short
 * strings from `<meta>` tags, the output is escaped by React on the way out, and a
 * tag this misses simply means a card without a subtitle. That trade is
 * deliberate; it would be the wrong one if this output were ever rendered as HTML,
 * which is why it must not be.
 */
export function parseMetadata(html: string, baseUrl: string): LinkMetadata {
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      // Either attribute order — property-then-content or content-then-property —
      // because both are common in the wild.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(
          `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
          "i",
        ),
        new RegExp(
          `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escaped}["']`,
          "i",
        ),
      ];
      for (const pattern of patterns) {
        const found = pattern.exec(html);
        if (found?.[1]) return found[1];
      }
    }
    return null;
  };

  // og: first, then Twitter's equivalents, then the plain HTML fallbacks — the
  // order sites actually intend them to be read in.
  const title =
    clean(meta("og:title", "twitter:title"), 300) ??
    clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 300);

  const description = clean(
    meta("og:description", "twitter:description", "description"),
    1000,
  );

  const siteName = clean(meta("og:site_name"), 120);
  const rawImage = meta("og:image", "og:image:url", "twitter:image");

  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      // Resolved against the page, so a relative og:image works — and re-parsed,
      // so only http/https survives. A `javascript:` og:image is a thing a hostile
      // page would absolutely try.
      const resolved = new URL(decodeEntities(rawImage.trim()), baseUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        imageUrl = resolved.toString().slice(0, 2048);
      }
    } catch {
      /* not a usable image */
    }
  }

  return { title, description, siteName, imageUrl };
}

/**
 * Fetches and parses one URL's metadata, or explains why not.
 *
 * Never throws. Every failure is an `{ ok: false }` the caller stores as a
 * negative cache entry — because the alternative is re-fetching a dead link on
 * every render of the message containing it.
 */
export async function fetchLinkMetadata(rawUrl: string): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Not a URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Unsupported scheme." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let current = url;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const result = await hop(current, controller.signal);

      if (result.kind === "error") return { ok: false, error: result.error };

      if (result.kind === "redirect") {
        let next: URL;
        try {
          next = new URL(result.to);
        } catch {
          return { ok: false, error: "Bad redirect." };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { ok: false, error: "Redirect to an unsupported scheme." };
        }
        current = next;
        continue;
      }

      const { response } = result;
      if (!response.ok) return { ok: false, error: `Answered ${response.status}.` };

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("html")) {
        // Not a page. Cancelled rather than read, so a link to a 2 GB file does
        // not become a 2 GB download.
        await response.body?.cancel().catch(() => {});
        return { ok: false, error: "Not an HTML page." };
      }

      const html = await readCapped(response);
      // `current`, not the original URL: a relative og:image has to resolve
      // against wherever we actually ended up.
      return { ok: true, metadata: parseMetadata(html, current.toString()) };
    }

    return { ok: false, error: "Too many redirects." };
  } finally {
    clearTimeout(timer);
  }
}

/** Reused by the image proxy, which needs exactly the same guard. */
export async function assertFetchableUrl(rawUrl: string): Promise<{ url: URL } | { error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "Not a URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Unsupported scheme." };
  }
  const blocked = await assertHostAllowed(url.hostname);
  return blocked ? { error: blocked } : { url };
}
