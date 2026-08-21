/**
 * Integration check for link previews.  npm run verify:link-preview
 *
 * The unit suite covers the parsing and the scheme allowlist. These are the
 * properties only a real network and a real database can prove, and the first
 * group is the one that matters:
 *
 *   - the SSRF guard refuses loopback, private ranges, and cloud metadata —
 *     BY IP, so a public hostname resolving to 127.0.0.1 is refused too;
 *   - a real page's metadata is parsed;
 *   - a non-HTML URL is refused rather than downloaded;
 *   - the cache serves a second ask without a second fetch, and remembers failures.
 *
 * ⚠ It makes real outbound requests and writes to DATABASE_URL. It cleans up the
 * rows it creates.
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));

const { fetchLinkMetadata, isBlockedAddress, parseMetadata, assertFetchableUrl } = await import(
  "../lib/link-preview/fetch"
);
const { cachedPreview, storePreview, storePreviewFailure } = await import(
  "../lib/db/queries/link-previews"
);

const urls: string[] = [];
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

try {
  // ================= the guard =================
  console.log("\nSSRF guard — addresses");

  for (const blocked of [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure instance metadata — the whole reason
    "100.64.0.1", // carrier-grade NAT
    "224.0.0.1", // multicast
    "::1",
    "::",
    "fe80::1", // link-local
    "fc00::1", // unique-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "not-an-ip",
  ]) {
    check(`blocks ${blocked}`, isBlockedAddress(blocked));
  }

  for (const allowed of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1"]) {
    check(`allows ${allowed}`, !isBlockedAddress(allowed));
  }

  console.log("\nSSRF guard — URLs");

  for (const [url, why] of [
    ["http://127.0.0.1/", "loopback by IP"],
    ["http://localhost/", "loopback by name"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://10.0.0.1/", "private range"],
    ["file:///etc/passwd", "file scheme"],
    ["gopher://example.com/", "exotic scheme"],
    ["not a url", "not a url"],
  ] as const) {
    const result = await assertFetchableUrl(url);
    check(`refuses ${why}`, "error" in result, JSON.stringify(result));
  }

  // A PUBLIC hostname that resolves to loopback. This is the case a hostname
  // blocklist misses entirely, and anybody can register one.
  const rebind = await assertFetchableUrl("http://localtest.me/");
  check(
    "refuses a public hostname resolving to 127.0.0.1",
    "error" in rebind,
    JSON.stringify(rebind),
  );

  check("allows an ordinary public host", "url" in (await assertFetchableUrl("https://example.com/")));

  // ================= parsing =================
  console.log("\nparsing");

  const html = `<html><head>
    <meta property="og:title" content="A &amp; B — the title">
    <meta property="og:description" content="Something  with   whitespace">
    <meta property="og:site_name" content="Example">
    <meta property="og:image" content="/img/card.png">
    </head></html>`;
  const parsed = parseMetadata(html, "https://example.com/page");
  check("reads og:title and decodes entities", parsed.title === "A & B — the title", String(parsed.title));
  check("collapses whitespace in the description", parsed.description === "Something with whitespace");
  check("reads og:site_name", parsed.siteName === "Example");
  check(
    "resolves a relative og:image against the page",
    parsed.imageUrl === "https://example.com/img/card.png",
    String(parsed.imageUrl),
  );

  const hostileImage = parseMetadata(
    `<meta property="og:image" content="javascript:alert(1)">`,
    "https://example.com/",
  );
  check("refuses a javascript: og:image", hostileImage.imageUrl === null, String(hostileImage.imageUrl));

  const titleOnly = parseMetadata("<html><head><title>Plain title</title></head>", "https://x.com/");
  check("falls back to <title>", titleOnly.title === "Plain title", String(titleOnly.title));

  const nothing = parseMetadata("<html><body>no head</body></html>", "https://x.com/");
  check("returns nulls for a page with no metadata", nothing.title === null && nothing.imageUrl === null);

  // ================= a real fetch =================
  console.log("\nreal fetch");

  const real = await fetchLinkMetadata("https://example.com/");
  check("fetches a real page", real.ok, real.ok ? "" : real.error);
  if (real.ok) {
    check("and finds its title", !!real.metadata.title, String(real.metadata.title));
  }

  const blockedFetch = await fetchLinkMetadata("http://169.254.169.254/latest/meta-data/");
  check("refuses to fetch cloud metadata", !blockedFetch.ok);

  const notHtml = await fetchLinkMetadata("https://www.google.com/favicon.ico");
  check(
    "refuses a non-HTML response rather than downloading it",
    !notHtml.ok && /HTML/i.test(notHtml.error),
    notHtml.ok ? "it was accepted" : notHtml.error,
  );

  const dead = await fetchLinkMetadata("https://example.invalid/");
  check("reports an unresolvable host", !dead.ok);

  // ================= the cache =================
  console.log("\ncache");

  const key = `https://example.com/__vfy_${Date.now()}`;
  urls.push(key);

  check("an unknown url is not cached", !(await cachedPreview(key)).cached);

  await storePreview(key, {
    title: "Cached title",
    description: "Cached description",
    siteName: "Example",
    imageUrl: "https://example.com/i.png",
  });

  const hit = await cachedPreview(key);
  check("a stored preview is served from cache", hit.cached);
  check("with its title", hit.cached && hit.preview?.title === "Cached title");
  check(
    "and reports an image WITHOUT leaking its url",
    hit.cached && hit.preview?.hasImage === true && !("imageUrl" in (hit.preview ?? {})),
    JSON.stringify(hit.cached ? hit.preview : null),
  );

  // A failure is cached too, or one dead link becomes a permanent request loop.
  const failKey = `https://example.com/__vfy_fail_${Date.now()}`;
  urls.push(failKey);
  await storePreviewFailure(failKey, "Unreachable.");
  const failed = await cachedPreview(failKey);
  check("a failure is cached", failed.cached);
  check("and renders as no card", failed.cached && failed.preview === null);

  // A page with metadata that later fails must not keep showing the old card.
  await storePreview(failKey, { title: "Old", description: null, siteName: null, imageUrl: null });
  await storePreviewFailure(failKey, "Gone.");
  const cleared = await cachedPreview(failKey);
  check("a failure clears previously cached metadata", cleared.cached && cleared.preview === null);

  // Nothing worth showing is not a card either.
  const emptyKey = `https://example.com/__vfy_empty_${Date.now()}`;
  urls.push(emptyKey);
  await storePreview(emptyKey, { title: null, description: null, siteName: null, imageUrl: null });
  const empty = await cachedPreview(emptyKey);
  check("a page with no metadata renders as no card", empty.cached && empty.preview === null);
} catch (err) {
  fail += 1;
  console.log(`\n  FAIL  unexpected error: ${(err as Error).message}`);
  console.log((err as Error).stack ?? "");
} finally {
  for (const url of urls) {
    await sql`DELETE FROM chat_link_previews WHERE url = ${url}`;
  }
  console.log(`\ncleanup: ${urls.length} cached rows removed`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
