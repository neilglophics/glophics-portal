import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropConfirmedPending, mergeMessages } from "../lib/chat/merge.ts";
import type { MessageRow } from "../lib/db/queries/chat.ts";

/**
 * The message list is the one component in this app that owns its own state
 * instead of re-rendering from the server, so this merge is what keeps it
 * honest. A bug here shows up as a message rendered twice, out of order, or
 * vanishing when an unrelated refresh happens to land.
 */

function msg(id: number, body = `m${id}`, clientMsgId = `c${id}`): MessageRow {
  return {
    id,
    conversationId: "conv",
    senderId: "sender",
    senderName: "Sender",
    clientMsgId,
    body,
    kind: "text",
    systemEvent: null,
    replyToId: null,
    replyTo: null,
    createdAt: new Date(1_700_000_000_000 + id).toISOString(),
    editedAt: null,
    deletedAt: null,
    reactions: [],
    attachments: [],
  };
}

const ids = (rows: MessageRow[]) => rows.map((m) => m.id);

describe("mergeMessages", () => {
  it("sorts ascending by id, oldest first", () => {
    assert.deepEqual(ids(mergeMessages([], [msg(3), msg(1), msg(2)])), [1, 2, 3]);
  });

  it("de-duplicates the same message arriving twice", () => {
    // A catch-up fetch and a live event can both deliver the same row.
    const once = mergeMessages([msg(1), msg(2)], [msg(2), msg(3)]);
    assert.deepEqual(ids(once), [1, 2, 3]);
  });

  it("lets an incoming copy WIN, so an edit is not discarded", () => {
    const merged = mergeMessages([msg(1, "before")], [msg(1, "after")]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.body, "after");
  });

  it("never drops a message already on screen", () => {
    // The property that makes it safe to merge the server's copy on every
    // refresh: a refresh racing a send cannot erase what is rendered.
    const onScreen = [msg(1), msg(2), msg(3)];
    const serverSubset = [msg(2)];
    assert.deepEqual(ids(mergeMessages(onScreen, serverSubset)), [1, 2, 3]);
  });

  it("returns the same array reference when nothing arrives", () => {
    // Cheap identity check so React can skip a re-render.
    const prev = [msg(1)];
    assert.equal(mergeMessages(prev, []), prev);
  });

  it("handles a large out-of-order batch without losing any", () => {
    const shuffled = [9, 2, 7, 1, 8, 3, 6, 4, 5].map((n) => msg(n));
    assert.deepEqual(ids(mergeMessages([], shuffled)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps a soft-deleted update over the original", () => {
    const deleted: MessageRow = { ...msg(1), deletedAt: new Date().toISOString(), body: "" };
    const merged = mergeMessages([msg(1, "secret")], [deleted]);
    assert.ok(merged[0]!.deletedAt);
    assert.equal(merged[0]!.body, "");
  });
});

describe("dropConfirmedPending", () => {
  it("removes an optimistic bubble once its real row is confirmed", () => {
    const pending = [{ clientMsgId: "c1", body: "hi", failed: false }];
    assert.deepEqual(dropConfirmedPending(pending, [msg(1, "hi", "c1")]), []);
  });

  it("leaves a pending message that is NOT yet confirmed", () => {
    const pending = [{ clientMsgId: "c9", body: "later", failed: false }];
    assert.deepEqual(dropConfirmedPending(pending, [msg(1, "hi", "c1")]), pending);
  });

  it("matches on clientMsgId, not on body — identical text is not the same message", () => {
    // Two people can legitimately send "ok". Matching on text would make one
    // of them disappear.
    const pending = [{ clientMsgId: "mine", body: "ok", failed: false }];
    assert.deepEqual(dropConfirmedPending(pending, [msg(1, "ok", "theirs")]), pending);
  });

  it("returns the same reference when there is nothing pending", () => {
    const pending: { clientMsgId: string }[] = [];
    assert.equal(dropConfirmedPending(pending, [msg(1)]), pending);
  });
});
