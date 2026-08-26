import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readReceipts, seenByLabel } from "../lib/chat/receipts.ts";

/**
 * Read state is one number per member, and the UI is a column of faces down the
 * edge of the thread. Turning the first into the second is where this can go
 * wrong in ways that are quietly untrue — showing somebody as having read less
 * than they have, or putting the same face on two messages.
 */

const msgs = (...ids: number[]) => ids.map((id) => ({ id }));

describe("readReceipts", () => {
  it("puts a face on the exact message somebody read up to", () => {
    const result = readReceipts(msgs(1, 2, 3), { alex: 2 }, "me");
    assert.deepEqual([...result.entries()], [[2, ["alex"]]]);
  });

  it("puts it on the newest LOADED message at or below the watermark", () => {
    // Their watermark is usually not an id in this page — they read up to 900 and
    // the page holds 880, 895, 910. The face belongs on 895.
    const result = readReceipts(msgs(880, 895, 910), { alex: 900 }, "me");
    assert.deepEqual([...result.entries()], [[895, ["alex"]]]);
  });

  it("shows nothing for somebody behind the loaded window", () => {
    // Guessing would put them on the oldest message on screen and claim they had
    // read less than they have.
    const result = readReceipts(msgs(500, 600), { alex: 100 }, "me");
    assert.equal(result.size, 0);
  });

  it("excludes the viewer", () => {
    // Your own face telling you that you have read your own conversation.
    const result = readReceipts(msgs(1, 2), { me: 2, alex: 2 }, "me");
    assert.deepEqual(result.get(2), ["alex"]);
  });

  it("groups several people on the same message", () => {
    const result = readReceipts(msgs(1, 2, 3), { alex: 3, jamie: 3, sam: 1 }, "me");
    assert.deepEqual(result.get(3), ["alex", "jamie"]);
    assert.deepEqual(result.get(1), ["sam"]);
  });

  it("gives each person exactly ONE position", () => {
    // The property that makes this a waterline rather than a badge: a face must
    // never appear twice in the thread.
    const result = readReceipts(msgs(1, 2, 3, 4), { alex: 4, jamie: 2 }, "me");
    const seen = [...result.values()].flat();
    assert.equal(seen.length, new Set(seen).size);
    assert.equal(seen.length, 2);
  });

  it("orders names within a message deterministically", () => {
    // Object key order follows whatever order read.changed events arrived in, so
    // without the sort the row of faces reshuffles between renders.
    const a = readReceipts(msgs(1), { zoe: 1, alex: 1 }, "me").get(1);
    const b = readReceipts(msgs(1), { alex: 1, zoe: 1 }, "me").get(1);
    assert.deepEqual(a, b);
  });

  it("ignores a zero watermark", () => {
    // Somebody who has never read anything in this conversation.
    assert.equal(readReceipts(msgs(1, 2), { alex: 0 }, "me").size, 0);
  });

  it("handles an empty thread and empty read state", () => {
    assert.equal(readReceipts([], { alex: 5 }, "me").size, 0);
    assert.equal(readReceipts(msgs(1, 2), {}, "me").size, 0);
  });

  it("places everybody on the newest message when the group is caught up", () => {
    const result = readReceipts(msgs(1, 2, 3), { alex: 3, jamie: 3 }, "me");
    assert.equal(result.size, 1);
    assert.deepEqual(result.get(3), ["alex", "jamie"]);
  });
});

describe("seenByLabel", () => {
  it("reads as a sentence", () => {
    assert.equal(seenByLabel(["Alex"]), "Seen by Alex");
    assert.equal(seenByLabel(["Alex", "Jamie"]), "Seen by Alex and Jamie");
    assert.equal(seenByLabel(["Alex", "Jamie", "Sam"]), "Seen by Alex, Jamie and Sam");
  });

  it("counts the rest past three", () => {
    assert.equal(
      seenByLabel(["Alex", "Jamie", "Sam", "Dee", "Eve"]),
      "Seen by Alex, Jamie, Sam and 2 others",
    );
  });

  it("says nothing about nobody", () => {
    assert.equal(seenByLabel([]), "");
  });
});
