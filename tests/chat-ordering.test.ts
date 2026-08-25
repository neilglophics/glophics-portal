import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effectiveActivity,
  orderConversations,
  preferLive,
  type LiveActivity,
  type OrderableConversation,
} from "../lib/chat/ordering.ts";

/**
 * "The newest conversation is at the top" is the whole feature, and it has to hold
 * against two sources of truth: the server's row and whatever has arrived live
 * since. The interesting cases are the disagreements — a refresh landing after an
 * event, two messages sharing a millisecond, a conversation with no messages at
 * all.
 */

const at = (iso: string): OrderableConversation => ({
  id: iso,
  lastMessageAt: iso,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const conv = (id: string, lastMessageAt: string | null, createdAt = "2026-01-01T00:00:00.000Z") =>
  ({ id, lastMessageAt, createdAt }) satisfies OrderableConversation;

const live = (lastMessageAt: string, seq: number): LiveActivity => ({ lastMessageAt, seq });

const ids = (rows: OrderableConversation[]) => rows.map((r) => r.id);

describe("effectiveActivity", () => {
  it("uses the server's timestamp when there is nothing live", () => {
    assert.deepEqual(effectiveActivity(conv("a", "2026-05-01T00:00:00.000Z"), undefined), {
      at: "2026-05-01T00:00:00.000Z",
      seq: 0,
    });
  });

  it("prefers the live timestamp when it is newer", () => {
    const result = effectiveActivity(
      conv("a", "2026-05-01T00:00:00.000Z"),
      live("2026-06-01T00:00:00.000Z", 3),
    );
    assert.equal(result.at, "2026-06-01T00:00:00.000Z");
  });

  it("keeps the SERVER's timestamp when the server is newer", () => {
    // A router.refresh() can land after an event. Taking the live value blindly
    // would walk the conversation backwards — a message arrives, the list updates
    // correctly, and then a refresh appears to undo it.
    const result = effectiveActivity(
      conv("a", "2026-06-01T00:00:00.000Z"),
      live("2026-05-01T00:00:00.000Z", 3),
    );
    assert.equal(result.at, "2026-06-01T00:00:00.000Z");
  });

  it("falls back to createdAt for a conversation with no messages", () => {
    // So a brand-new empty conversation appears where the person who just made it
    // will look for it, rather than at the bottom with the nulls.
    const result = effectiveActivity(conv("a", null, "2026-07-01T00:00:00.000Z"), undefined);
    assert.equal(result.at, "2026-07-01T00:00:00.000Z");
  });
});

describe("orderConversations", () => {
  it("sorts newest first", () => {
    const rows = [
      at("2026-01-02T00:00:00.000Z"),
      at("2026-01-03T00:00:00.000Z"),
      at("2026-01-01T00:00:00.000Z"),
    ];
    assert.deepEqual(ids(orderConversations(rows, {})), [
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("moves a conversation to the top when a message arrives in it", () => {
    // The example from the requirement: A, B, C — a message lands in C, so C leads.
    const rows = [
      conv("A", "2026-01-03T00:00:00.000Z"),
      conv("B", "2026-01-02T00:00:00.000Z"),
      conv("C", "2026-01-01T00:00:00.000Z"),
    ];
    const ordered = orderConversations(rows, { C: live("2026-01-04T00:00:00.000Z", 1) });
    assert.deepEqual(ids(ordered), ["C", "A", "B"]);
  });

  it("keeps the order correct when several messages arrive close together", () => {
    const rows = [conv("A", "2026-01-01T00:00:00.000Z"), conv("B", "2026-01-01T00:00:00.000Z"), conv("C", "2026-01-01T00:00:00.000Z")];
    const ordered = orderConversations(rows, {
      A: live("2026-01-02T00:00:00.000Z", 1),
      C: live("2026-01-02T00:00:00.100Z", 2),
      B: live("2026-01-02T00:00:00.200Z", 3),
    });
    assert.deepEqual(ids(ordered), ["B", "C", "A"]);
  });

  it("breaks an exact timestamp tie on arrival order", () => {
    // Two people sending in the same millisecond. Without the seq tiebreak the
    // order falls to the engine's sort stability and the order the objects
    // happened to be in — so the top two rows swap on unrelated renders.
    const same = "2026-01-05T00:00:00.000Z";
    const rows = [conv("A", null), conv("B", null)];
    const ordered = orderConversations(rows, { A: live(same, 1), B: live(same, 2) });
    assert.deepEqual(ids(ordered), ["B", "A"]);
  });

  it("is deterministic when everything ties", () => {
    const rows = [conv("b", "2026-01-01T00:00:00.000Z"), conv("a", "2026-01-01T00:00:00.000Z")];
    assert.deepEqual(ids(orderConversations(rows, {})), ["a", "b"]);
    // The same input twice must give the same answer, or the list flickers.
    assert.deepEqual(orderConversations(rows, {}), orderConversations(rows, {}));
  });

  it("does not mutate its input", () => {
    // It is React props.
    const rows = [conv("A", "2026-01-01T00:00:00.000Z"), conv("B", "2026-01-09T00:00:00.000Z")];
    const before = ids(rows);
    orderConversations(rows, {});
    assert.deepEqual(ids(rows), before);
  });

  it("never duplicates or drops a conversation", () => {
    // Merging by id rather than concatenating is what prevents a duplicate entry
    // when live data arrives for a row that is already there.
    const rows = [conv("A", "2026-01-01T00:00:00.000Z"), conv("B", null), conv("C", "2026-02-01T00:00:00.000Z")];
    const ordered = orderConversations(rows, { A: live("2026-03-01T00:00:00.000Z", 1) });
    assert.equal(ordered.length, 3);
    assert.deepEqual([...ids(ordered)].sort(), ["A", "B", "C"]);
  });

  it("ignores live activity for a conversation that is not in the list", () => {
    // A message can arrive for a conversation the server has not rendered yet —
    // that needs a refresh to add the row, not a phantom entry here.
    const rows = [conv("A", "2026-01-01T00:00:00.000Z")];
    const ordered = orderConversations(rows, { GHOST: live("2026-09-01T00:00:00.000Z", 1) });
    assert.deepEqual(ids(ordered), ["A"]);
  });
});

describe("preferLive", () => {
  it("agrees with the sort about which copy wins", () => {
    // If these disagreed, a row would move to the top while still showing the
    // previous message underneath it.
    const older = conv("a", "2026-01-01T00:00:00.000Z");
    const newer = live("2026-02-01T00:00:00.000Z", 1);

    assert.equal(preferLive(older, newer), true);
    assert.equal(effectiveActivity(older, newer).at, newer.lastMessageAt);

    const stale = live("2025-01-01T00:00:00.000Z", 1);
    assert.equal(preferLive(older, stale), false);
    assert.equal(effectiveActivity(older, stale).at, older.lastMessageAt);
  });

  it("is false when there is nothing live", () => {
    assert.equal(preferLive(conv("a", "2026-01-01T00:00:00.000Z"), undefined), false);
  });

  it("is true for a conversation that had no messages", () => {
    assert.equal(preferLive(conv("a", null), live("2026-01-01T00:00:00.000Z", 1)), true);
  });
});
