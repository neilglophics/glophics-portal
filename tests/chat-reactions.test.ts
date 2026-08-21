import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REACTION_EMOJI,
  applyReactionToggle,
  isAllowedReaction,
  mergeReactionGroup,
  reactedByViewer,
  reactionTooltip,
  type ReactionGroup,
} from "../lib/chat/reactions.ts";

/**
 * Reactions have two halves that must agree: an optimistic toggle applied the
 * instant somebody taps, and a server-authoritative group folded in when the
 * event arrives. A bug in either shows up as a count that is wrong, a pill that
 * will not go away, or a row that reshuffles under the cursor — all of which look
 * like the feature is broken rather than like an off-by-one.
 */

const sem = { id: "sem", displayName: "Sem" };
const jerome = { id: "jerome", displayName: "Jerome" };
const alex = { id: "alex", displayName: "Alex" };

const group = (emoji: string, ...users: { id: string; displayName: string }[]): ReactionGroup => ({
  emoji,
  users,
});

describe("the allowlist", () => {
  it("accepts every emoji the picker offers", () => {
    for (const emoji of REACTION_EMOJI) {
      assert.equal(isAllowedReaction(emoji), true, `${emoji} should be allowed`);
    }
  });

  it("refuses anything else", () => {
    // The picker is courtesy; this is the boundary. A free-text emoji field is a
    // free-text field, which is the thing the closed set exists to prevent.
    for (const value of ["🤔", "", "x", "👍👍", null, undefined, 1, {}]) {
      assert.equal(isAllowedReaction(value), false, `${String(value)} should be refused`);
    }
  });
});

describe("applyReactionToggle", () => {
  it("adds a brand-new emoji at the end", () => {
    const next = applyReactionToggle([group("👍", jerome)], "🎉", sem);
    assert.deepEqual(
      next.map((g) => g.emoji),
      ["👍", "🎉"],
    );
    assert.deepEqual(next[1]!.users, [sem]);
  });

  it("joins an emoji somebody else already used", () => {
    const next = applyReactionToggle([group("👍", jerome)], "👍", sem);
    assert.deepEqual(next[0]!.users.map((u) => u.id), ["jerome", "sem"]);
  });

  it("is its own inverse", () => {
    // A double-tap must land exactly back where it started, or the UI keeps a
    // phantom reaction that only a reload clears.
    const before = [group("👍", jerome), group("🎉", alex)];
    const once = applyReactionToggle(before, "👍", sem);
    const twice = applyReactionToggle(once, "👍", sem);
    assert.deepEqual(twice, before);
  });

  it("drops the pill when the last reactor leaves", () => {
    // Not "😂 0" — a zero is not a state.
    const next = applyReactionToggle([group("😂", sem), group("👍", alex)], "😂", sem);
    assert.deepEqual(
      next.map((g) => g.emoji),
      ["👍"],
    );
  });

  it("keeps existing pills in place while their counts change", () => {
    // A row that reshuffles cannot be clicked twice in a row.
    const before = [group("👍", jerome), group("❤️", alex), group("🎉", jerome)];
    const next = applyReactionToggle(before, "❤️", sem);
    assert.deepEqual(
      next.map((g) => g.emoji),
      ["👍", "❤️", "🎉"],
    );
    assert.equal(next[1]!.users.length, 2);
  });

  it("does not mutate what it was given", () => {
    const before = [group("👍", jerome)];
    applyReactionToggle(before, "👍", sem);
    assert.deepEqual(before[0]!.users, [jerome]);
  });
});

describe("mergeReactionGroup", () => {
  it("replaces the emoji it carries and leaves the rest alone", () => {
    const next = mergeReactionGroup(
      [group("👍", sem), group("🎉", alex)],
      group("👍", sem, jerome, alex),
    );
    assert.equal(next[0]!.users.length, 3);
    assert.deepEqual(next[1]!.users, [alex]);
  });

  it("is idempotent", () => {
    // THE property the whole design rests on: whole groups rather than deltas, so
    // a duplicate event — or one racing this tab's own optimistic toggle — cannot
    // count the same tap twice.
    const incoming = group("👍", sem, jerome);
    const once = mergeReactionGroup([group("👍", sem)], incoming);
    const twice = mergeReactionGroup(once, incoming);
    assert.deepEqual(twice, once);
  });

  it("appends an emoji it has not seen", () => {
    const next = mergeReactionGroup([group("👍", sem)], group("😮", alex));
    assert.deepEqual(
      next.map((g) => g.emoji),
      ["👍", "😮"],
    );
  });

  it("drops the pill on an empty group", () => {
    // What the server sends when the last reactor removed theirs.
    const next = mergeReactionGroup([group("👍", sem), group("🎉", alex)], group("👍"));
    assert.deepEqual(
      next.map((g) => g.emoji),
      ["🎉"],
    );
  });

  it("stays empty when an empty group arrives for an emoji nobody has", () => {
    const next = mergeReactionGroup([], group("👍"));
    assert.deepEqual(next, []);
  });
});

describe("reactedByViewer", () => {
  it("distinguishes the viewer from everybody else", () => {
    assert.equal(reactedByViewer(group("👍", sem, jerome), "sem"), true);
    assert.equal(reactedByViewer(group("👍", sem, jerome), "alex"), false);
  });
});

describe("reactionTooltip", () => {
  it("puts the viewer first", () => {
    // The reader wants to know whether THEY reacted before they want to know who
    // else did.
    assert.equal(reactionTooltip(group("👍", jerome, sem), "sem"), "You and Jerome");
  });

  it("reads as a sentence for two and three", () => {
    assert.equal(reactionTooltip(group("👍", sem), "alex"), "Sem");
    assert.equal(reactionTooltip(group("👍", sem, jerome), "alex"), "Sem and Jerome");
    assert.equal(reactionTooltip(group("👍", sem, jerome, alex), "x"), "Sem, Jerome and Alex");
  });

  it("counts the rest past three", () => {
    // A tooltip taller than the message it describes is not a tooltip.
    const many = group(
      "👍",
      sem,
      jerome,
      alex,
      { id: "d", displayName: "Dee" },
      { id: "e", displayName: "Eve" },
    );
    assert.equal(reactionTooltip(many, "x"), "Sem, Jerome, Alex and 2 others");
    assert.equal(reactionTooltip(many, "sem"), "You, Jerome, Alex and 2 others");
  });

  it("says nothing about nobody", () => {
    assert.equal(reactionTooltip(group("👍"), "sem"), "");
  });
});
