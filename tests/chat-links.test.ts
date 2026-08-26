import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractLinks,
  linkLabel,
  previewableLink,
  safeHref,
  segments,
  youtubeEmbedUrl,
} from "../lib/chat/links.ts";

/**
 * Linkifying is the classic reason people reach for innerHTML, and this app's
 * seventh invariant says everything a user types stays escaped. These tests pin
 * both halves of the alternative: `safeHref` refuses any scheme that could execute
 * in our origin, and `segments` accounts for every character so the renderer can
 * emit React children instead of markup.
 */

describe("safeHref", () => {
  it("accepts http and https", () => {
    assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
    assert.equal(safeHref("http://example.com/"), "http://example.com/");
  });

  it("assumes https for a bare www host", () => {
    // People paste both forms, and a bare www. link that is not clickable reads
    // as a bug.
    assert.equal(safeHref("www.example.com"), "https://www.example.com/");
  });

  it("refuses every scheme that could execute in our origin", () => {
    // THE test in this file. A javascript: href runs in the origin holding
    // everybody's session cookie; a data:text/html href renders attacker markup
    // there. Checked on the PARSED protocol, so casing and embedded whitespace
    // tricks do not get a second chance.
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/uuid",
      "about:blank",
    ]) {
      assert.equal(safeHref(hostile), null, `${hostile} must not become a link`);
    }
  });

  it("refuses things that are not URLs at all", () => {
    for (const value of ["", "not a url", "http://", "https://"]) {
      assert.equal(safeHref(value), null, `${value} should be refused`);
    }
  });
});

describe("segments", () => {
  /** The invariant that makes the no-HTML rendering correct. */
  const isLossless = (body: string) =>
    segments(body)
      .map((s) => s.value)
      .join("") === body;

  it("returns a single text run for a body with no links", () => {
    assert.deepEqual(segments("just talking"), [{ kind: "text", value: "just talking" }]);
  });

  it("splits text around a link", () => {
    const parts = segments("see https://example.com/a now");
    assert.deepEqual(parts, [
      { kind: "text", value: "see " },
      { kind: "link", value: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", value: " now" },
    ]);
  });

  it("accounts for every character of the input", () => {
    // Nothing dropped, nothing duplicated. If this ever fails, the renderer is
    // silently losing part of somebody's message.
    for (const body of [
      "https://example.com",
      "a https://example.com b",
      "https://a.com https://b.com",
      "trailing https://example.com/x.",
      "(https://example.com)",
      "no links here",
      "",
      "javascript:alert(1)",
      "multi\nline https://example.com/x\nmore",
    ]) {
      assert.equal(isLossless(body), true, `lossy for: ${JSON.stringify(body)}`);
    }
  });

  it("leaves a full stop out of the URL", () => {
    const parts = segments("go to https://example.com/page.");
    assert.equal(parts[1]!.value, "https://example.com/page");
    assert.deepEqual(parts[2], { kind: "text", value: "." });
  });

  it("leaves other sentence punctuation out too", () => {
    for (const [body, expected] of [
      ["look: https://example.com/a, then", "https://example.com/a"],
      ["really? https://example.com/a?", "https://example.com/a"],
      ["wow https://example.com/a!", "https://example.com/a"],
    ] as const) {
      const link = segments(body).find((s) => s.kind === "link")!;
      assert.equal(link.value, expected);
    }
  });

  it("drops an unbalanced closing bracket", () => {
    const parts = segments("(see https://example.com)");
    assert.equal(parts.find((s) => s.kind === "link")!.value, "https://example.com");
  });

  it("KEEPS balanced brackets inside a URL", () => {
    // Wikipedia and Jira both produce these. Trimming every trailing bracket
    // would quietly break the link.
    const url = "https://en.wikipedia.org/wiki/Foo_(disambiguation)";
    assert.equal(segments(`see ${url}`).find((s) => s.kind === "link")!.value, url);
  });

  it("renders a dangerous scheme as plain text", () => {
    // Not a link, and not dropped either — it stays visible as what somebody typed.
    const parts = segments("javascript:alert(1)");
    assert.equal(parts.every((s) => s.kind === "text"), true);
    assert.equal(parts.map((s) => s.value).join(""), "javascript:alert(1)");
  });

  it("finds several links in one message", () => {
    const parts = segments("https://a.com and https://b.com");
    assert.deepEqual(
      parts.filter((s) => s.kind === "link").map((s) => s.value),
      ["https://a.com", "https://b.com"],
    );
  });

  it("is not stateful between calls", () => {
    // A module-level /g/ regex would carry lastIndex across calls, so the second
    // render of the same string would find nothing.
    const body = "https://example.com/a";
    assert.deepEqual(segments(body), segments(body));
  });

  it("handles a link with no surrounding text", () => {
    assert.deepEqual(segments("https://example.com/a"), [
      { kind: "link", value: "https://example.com/a", href: "https://example.com/a" },
    ]);
  });
});

describe("extractLinks and previewableLink", () => {
  it("returns the NORMALISED url, not the typed text", () => {
    // `safeHref` re-serialises through URL, so a bare host gains its root slash.
    // That is the point: these values are the primary key of the preview cache, so
    // "https://a.com" and "https://a.com/" have to be one row rather than two.
    // The text shown in the bubble stays whatever was typed — see `segments`,
    // where `value` and `href` are deliberately different.
    assert.deepEqual(extractLinks("go to https://a.com"), ["https://a.com/"]);
  });

  it("de-duplicates", () => {
    assert.deepEqual(extractLinks("https://a.com and https://a.com again"), ["https://a.com/"]);
  });

  it("de-duplicates forms that differ only by normalisation", () => {
    assert.deepEqual(extractLinks("https://a.com and https://a.com/ again"), ["https://a.com/"]);
  });

  it("takes the first link for the card", () => {
    // One card per message. Six pasted URLs would otherwise be a wall of cards
    // taller than the conversation.
    assert.equal(previewableLink("https://a.com then https://b.com"), "https://a.com/");
  });

  it("is null when there is nothing to preview", () => {
    assert.equal(previewableLink("no links"), null);
    assert.equal(previewableLink("javascript:alert(1)"), null);
  });
});

describe("youtubeEmbedUrl", () => {
  it("supports watch, short, shorts, and embed URLs", () => {
    const id = "dQw4w9WgXcQ";
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://m.youtube.com/shorts/${id}`,
      `https://youtube.com/embed/${id}`,
    ]) {
      assert.equal(youtubeEmbedUrl(url), `https://www.youtube-nocookie.com/embed/${id}`);
    }
  });

  it("rejects lookalike hosts, insecure URLs, and invalid IDs", () => {
    for (const url of [
      "https://evil-youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/not-a-video!",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%20onload%3Dalert(1)",
    ]) {
      assert.equal(youtubeEmbedUrl(url), null, url);
    }
  });
});

describe("linkLabel", () => {
  it("drops the scheme and a trailing slash", () => {
    assert.equal(linkLabel("https://example.com/"), "example.com");
    assert.equal(linkLabel("https://www.example.com/a"), "example.com/a");
  });

  it("keeps a short URL whole", () => {
    assert.equal(linkLabel("https://example.com/a/b?c=d"), "example.com/a/b?c=d");
  });

  it("truncates in the MIDDLE of a long URL", () => {
    // The end of a URL is often the identifying part — an issue key, a comment id
    // — so cutting only the tail throws away the half that says where it goes.
    const long = `https://example.com/${"a".repeat(100)}/IMPORTANT-42`;
    const label = linkLabel(long, 40);
    assert.ok(label.length <= 40, `got ${label.length}`);
    assert.ok(label.includes("…"));
    assert.ok(label.startsWith("example.com/"));
    assert.ok(label.endsWith("42"), label);
  });

  it("does not throw on something unparseable", () => {
    assert.equal(typeof linkLabel("not a url"), "string");
  });
});
