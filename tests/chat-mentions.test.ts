import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjustMentions,
  filterMentionCandidates,
  insertMention,
  serializeMentions,
  mentionQueryAt,
  mentionSegments,
  mentionToken,
  mentionedIds,
  mentions,
  plainText,
  sanitizeMentionName,
} from "../lib/chat/mentions.ts";

/**
 * A mention is stored as `@[Name](uuid)`, so three things have to hold or the
 * feature misbehaves in ways that look like data loss: the split must account for
 * every character, the plain form must never leak a uuid into a preview or a
 * length count, and the "am I typing a mention right now" test must not fire on
 * ordinary prose.
 */

const ALEX = "11111111-2222-3333-4444-555555555555";
const JAMIE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("mentionToken and sanitizeMentionName", () => {
  it("builds the stored form", () => {
    assert.equal(mentionToken(ALEX, "Alex Tan"), `@[Alex Tan](${ALEX})`);
  });

  it("strips the characters that would break the token", () => {
    // `]` would end the name early and the parens would confuse the id part.
    assert.equal(sanitizeMentionName("Smith] (QA)"), "Smith QA");
    assert.equal(sanitizeMentionName("a[b]c"), "abc");
  });

  it("collapses whitespace and never returns empty", () => {
    assert.equal(sanitizeMentionName("  Jan   Fred "), "Jan Fred");
    assert.equal(sanitizeMentionName("   "), "someone");
    assert.equal(sanitizeMentionName("()"), "someone");
  });

  it("round-trips a sanitised name through the parser", () => {
    const token = mentionToken(ALEX, "Weird ]Name( here");
    const parsed = mentionSegments(token);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.kind, "mention");
  });
});

describe("mentionSegments", () => {
  const isLossless = (body: string) =>
    mentionSegments(body)
      .map((s) => (s.kind === "mention" ? s.raw : s.value))
      .join("") === body;

  it("splits text around a mention", () => {
    const parts = mentionSegments(`hey @[Alex](${ALEX}) look`);
    assert.deepEqual(parts.map((p) => p.kind), ["text", "mention", "text"]);
    assert.equal(parts[0]!.kind === "text" && parts[0]!.value, "hey ");
    assert.equal(parts[1]!.kind === "mention" && parts[1]!.userId, ALEX);
  });

  it("accounts for every character", () => {
    for (const body of [
      `@[Alex](${ALEX})`,
      `hi @[Alex](${ALEX})`,
      `@[Alex](${ALEX}) and @[Jamie](${JAMIE})`,
      "no mentions here",
      "",
      "an @ on its own",
      `@[Alex](${ALEX})@[Jamie](${JAMIE})`,
    ]) {
      assert.equal(isLossless(body), true, `lossy for ${JSON.stringify(body)}`);
    }
  });

  it("ignores something that only looks like a token", () => {
    // Not a uuid, so not a mention — it stays as text rather than becoming a
    // chip pointing at nobody.
    const parts = mentionSegments("@[Alex](not-a-uuid)");
    assert.equal(parts.every((p) => p.kind === "text"), true);
  });

  it("is not stateful between calls", () => {
    const body = `@[Alex](${ALEX})`;
    assert.deepEqual(mentionSegments(body), mentionSegments(body));
  });
});

describe("plainText", () => {
  it("renders a token as the name a person sees", () => {
    assert.equal(plainText(`hey @[Alex](${ALEX}) look`), "hey @Alex look");
  });

  it("never leaks a uuid", () => {
    // This value reaches the conversation-list preview, the toast and the length
    // count. A uuid in any of them is both ugly and 36 characters nobody typed.
    const result = plainText(`@[Alex](${ALEX}) and @[Jamie](${JAMIE})`);
    assert.equal(result, "@Alex and @Jamie");
    assert.equal(result.includes(ALEX), false);
  });

  it("leaves a body with no mentions alone", () => {
    assert.equal(plainText("just talking"), "just talking");
  });
});

describe("mentionedIds", () => {
  it("collects ids in order, de-duplicated", () => {
    assert.deepEqual(
      mentionedIds(`@[Alex](${ALEX}) @[Jamie](${JAMIE}) @[Alex again](${ALEX})`),
      [ALEX, JAMIE],
    );
  });

  it("is case-insensitive about the id", () => {
    assert.equal(mentions(`@[Alex](${ALEX.toUpperCase()})`, ALEX), true);
  });

  it("finds nothing in ordinary text", () => {
    assert.deepEqual(mentionedIds("no mentions"), []);
  });
});

describe("mentionQueryAt", () => {
  it("opens right after an @", () => {
    const query = mentionQueryAt("hello @", 7);
    assert.deepEqual(query, { start: 6, end: 7, term: "" });
  });

  it("captures what is typed after it", () => {
    assert.equal(mentionQueryAt("hi @jan", 7)?.term, "jan");
  });

  it("allows ONE space, so a full name can be searched", () => {
    // "@John S" is still a search; display names have spaces in them.
    assert.equal(mentionQueryAt("@John S", 7)?.term, "John S");
    // Two spaces is prose, not a search.
    assert.equal(mentionQueryAt("@John Smith went", 16), null);
  });

  it("does not fire inside an email address", () => {
    // The @ must begin a word, or every address typed in chat opens a member list.
    assert.equal(mentionQueryAt("mail me at bob@example.com", 26), null);
  });

  it("does not cross a newline", () => {
    assert.equal(mentionQueryAt("@alex\nnext line", 15), null);
  });

  it("is null when there is no @ at all", () => {
    assert.equal(mentionQueryAt("just typing", 11), null);
  });

  it("uses the @ nearest the caret", () => {
    const query = mentionQueryAt("@one and @two", 13);
    assert.equal(query?.term, "two");
  });
});

describe("filterMentionCandidates", () => {
  const people = [
    { displayName: "Jan Fred", username: "janf" },
    { displayName: "Sanjay Patel", username: "sanjay" },
    { displayName: "John Smith", username: "jsmith" },
    { displayName: "Ashley Bayarcal", username: "ash" },
  ];

  it("returns everybody for an empty term", () => {
    assert.equal(filterMentionCandidates(people, "").length, 4);
  });

  it("ranks a name prefix above a match in the middle", () => {
    // Typing "ja" should offer "Jan" before "Sanjay".
    const result = filterMentionCandidates(people, "ja");
    assert.equal(result[0]!.displayName, "Jan Fred");
    assert.ok(result.some((p) => p.displayName === "Sanjay Patel"));
  });

  it("matches a username", () => {
    assert.equal(filterMentionCandidates(people, "ash")[0]!.displayName, "Ashley Bayarcal");
  });

  it("matches a last name", () => {
    // "smith" should find "John Smith" — people reach for either part.
    assert.equal(filterMentionCandidates(people, "smith")[0]!.displayName, "John Smith");
  });

  it("returns nothing when nobody matches", () => {
    assert.deepEqual(filterMentionCandidates(people, "zzzz"), []);
  });

  it("respects the limit", () => {
    assert.equal(filterMentionCandidates(people, "", 2).length, 2);
  });
});

/**
 * The composer holds PLAIN text — "@Super Admin", never the stored
 * `@[Super Admin](uuid)`. Showing a uuid to somebody mid-sentence was the bug
 * these functions exist to prevent, so the properties worth pinning are: the
 * inserted text is clean, the ranges keep up with editing, and the token only ever
 * appears at send time.
 */
describe("insertMention", () => {
  it("inserts plain text, with no uuid anywhere", () => {
    const text = "hey @al";
    const query = mentionQueryAt(text, text.length)!;
    const result = insertMention(text, [], query, { id: ALEX, displayName: "Alex Tan" });

    assert.equal(result.text, "hey @Alex Tan ");
    assert.equal(result.text.includes(ALEX), false);
  });

  it("records the range covering @Name, not the trailing space", () => {
    const text = "@al";
    const query = mentionQueryAt(text, 3)!;
    const result = insertMention(text, [], query, { id: ALEX, displayName: "Alex" });

    const [mention] = result.mentions;
    assert.equal(result.text.slice(mention!.start, mention!.end), "@Alex");
    // Typing after the mention must not read as editing it.
    assert.equal(result.text[mention!.end], " ");
  });

  it("puts the caret after the mention, keeping the rest of the sentence", () => {
    const text = "hey @al how are you";
    const query = mentionQueryAt(text, 7)!;
    const result = insertMention(text, [], query, { id: ALEX, displayName: "Alex" });

    assert.equal(result.text, "hey @Alex  how are you");
    assert.equal(result.text.slice(result.caret), " how are you");
  });

  it("shifts an earlier mention's range when a second is added before it", () => {
    let state = { text: "@a and @b", mentions: [] as ReturnType<typeof insertMention>["mentions"] };
    // Insert the SECOND one first, then one before it, to prove the shifting.
    const second = insertMention(state.text, state.mentions, mentionQueryAt(state.text, 9)!, {
      id: JAMIE,
      displayName: "Jamie",
    });
    state = { text: second.text, mentions: second.mentions };

    const first = insertMention(state.text, state.mentions, mentionQueryAt(state.text, 2)!, {
      id: ALEX,
      displayName: "Alexander",
    });

    // Both ranges still point at their own names after the earlier insert grew.
    for (const mention of first.mentions) {
      assert.equal(first.text.slice(mention.start, mention.end), `@${mention.name}`);
    }
  });
});

describe("adjustMentions", () => {
  const base = [{ start: 4, end: 9, userId: ALEX, name: "Alex" }];

  it("shifts a mention when text is inserted before it", () => {
    const moved = adjustMentions(base, "hey @Alex", "hey hey @Alex");
    assert.deepEqual(moved[0], { start: 8, end: 13, userId: ALEX, name: "Alex" });
  });

  it("leaves it alone when text is added after it", () => {
    assert.deepEqual(adjustMentions(base, "hey @Alex", "hey @Alex there"), base);
  });

  it("DROPS it when the name itself is edited", () => {
    // Backspacing into "@Alex" clearly no longer means that mention. Keeping the
    // range would send a token whose visible text does not match who it points at.
    assert.deepEqual(adjustMentions(base, "hey @Alex", "hey @Ale"), []);
    assert.deepEqual(adjustMentions(base, "hey @Alex", "hey @Alexx"), []);
  });

  it("handles a multi-character delete before the mention", () => {
    const moved = adjustMentions(base, "hey @Alex", "@Alex");
    assert.equal(moved[0]!.start, 0);
    assert.equal(moved[0]!.end, 5);
  });

  it("handles a paste", () => {
    const moved = adjustMentions(base, "hey @Alex", "hey PASTED @Alex");
    assert.equal("hey PASTED @Alex".slice(moved[0]!.start, moved[0]!.end), "@Alex");
  });

  it("returns the ranges unchanged when nothing changed", () => {
    assert.deepEqual(adjustMentions(base, "hey @Alex", "hey @Alex"), base);
  });

  it("keeps every surviving range pointing at its own name", () => {
    // The property that matters: after ANY edit, a range either survives pointing
    // at its name or is gone. It must never point at the wrong text.
    const text = "@Alex and @Jamie";
    const mentions = [
      { start: 0, end: 5, userId: ALEX, name: "Alex" },
      { start: 10, end: 16, userId: JAMIE, name: "Jamie" },
    ];
    for (const next of ["x@Alex and @Jamie", "@Alex and @Jamie!", "@Alex and @Jamie extra", "@Alex"]) {
      for (const mention of adjustMentions(mentions, text, next)) {
        assert.equal(
          next.slice(mention.start, mention.end),
          `@${mention.name}`,
          `range drifted for ${JSON.stringify(next)}`,
        );
      }
    }
  });
});

describe("serializeMentions", () => {
  it("turns the plain draft into stored tokens", () => {
    const result = serializeMentions("hey @Alex there", [
      { start: 4, end: 9, userId: ALEX, name: "Alex" },
    ]);
    assert.equal(result, `hey @[Alex](${ALEX}) there`);
    assert.deepEqual(mentionedIds(result), [ALEX]);
  });

  it("handles several, without the earlier ones shifting the later ones", () => {
    // Applied right-to-left; left-to-right is the classic off-by-everything bug
    // when rewriting several spans of one string.
    const text = "@Alex and @Jamie";
    const result = serializeMentions(text, [
      { start: 0, end: 5, userId: ALEX, name: "Alex" },
      { start: 10, end: 16, userId: JAMIE, name: "Jamie" },
    ]);
    assert.equal(result, `@[Alex](${ALEX}) and @[Jamie](${JAMIE})`);
    assert.deepEqual(mentionedIds(result), [ALEX, JAMIE]);
  });

  it("skips a range whose text no longer matches", () => {
    // The second net behind adjustMentions. A token is a claim about who is being
    // addressed; it must never be generated from text that says something else.
    const result = serializeMentions("hey @Bob there", [
      { start: 4, end: 9, userId: ALEX, name: "Alex" },
    ]);
    assert.equal(result, "hey @Bob there");
    assert.deepEqual(mentionedIds(result), []);
  });

  it("skips an out-of-bounds range", () => {
    assert.equal(serializeMentions("short", [{ start: 0, end: 99, userId: ALEX, name: "Alex" }]), "short");
  });

  it("is a no-op with no mentions", () => {
    assert.equal(serializeMentions("just talking", []), "just talking");
  });

  it("round-trips back to the draft through plainText", () => {
    // What the sender typed and what everybody reads are the same string.
    const draft = "hey @Alex there";
    const stored = serializeMentions(draft, [{ start: 4, end: 9, userId: ALEX, name: "Alex" }]);
    assert.equal(plainText(stored), draft);
  });
});

describe("adjustMentions — the boundary at a mention's end", () => {
  const base = [{ start: 4, end: 9, userId: ALEX, name: "Alex" }];

  it("drops the mention when a name character is typed onto the end", () => {
    // "@Alex" + "x" reads "@Alexx". Keeping the range would send a token naming
    // Alex under text that says something else.
    assert.deepEqual(adjustMentions(base, "hey @Alex", "hey @Alexx"), []);
  });

  it("keeps it when the insert cannot be part of a name", () => {
    for (const next of ["hey @Alex there", "hey @Alex, ok", "hey @Alex!"]) {
      assert.equal(adjustMentions(base, "hey @Alex", next).length, 1, next);
    }
  });

  it("keeps it when the trailing space is deleted", () => {
    // The state insertMention actually produces, then a backspace. The name is
    // untouched, so the mention survives.
    const withSpace = [{ start: 4, end: 9, userId: ALEX, name: "Alex" }];
    assert.deepEqual(adjustMentions(withSpace, "hey @Alex ", "hey @Alex"), withSpace);
  });

  it("shifts rather than absorbs an insert at the @ itself", () => {
    const moved = adjustMentions(base, "hey @Alex", "hey X@Alex");
    assert.equal("hey X@Alex".slice(moved[0]!.start, moved[0]!.end), "@Alex");
  });
});
