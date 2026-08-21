import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELETED_MESSAGE_PREVIEW,
  applyMessageDeletion,
  dropConfirmedPending,
  mergeMessages,
} from "../lib/chat/merge.ts";
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

/**
 * Deleting a message changes two things on screen, and the second is the one that
 * was missed for a while: the message itself, AND every reply quoting it. The
 * server had always been right (replyPreviewFrom checks the parent's deleted_at),
 * so the stale quote only appeared on a thread that was already open — which is
 * every thread, for everybody who was looking at it when it happened.
 */
describe("applyMessageDeletion", () => {
  const withReplyTo = (id: number, parentId: number): MessageRow => ({
    ...msg(id),
    replyTo: {
      id: parentId,
      senderId: "sender",
      senderName: "Sender",
      preview: "the original text",
      deleted: false,
      thumbnailAttachmentId: "att-1",
      attachmentCount: 1,
    },
  });

  it("empties the deleted message", () => {
    const out = applyMessageDeletion([msg(1, "secret")], 1, "2026-08-21T00:00:00.000Z");
    assert.equal(out[0]!.body, "");
    assert.equal(out[0]!.deletedAt, "2026-08-21T00:00:00.000Z");
  });

  it("strips its reactions and attachments", () => {
    const target: MessageRow = {
      ...msg(1),
      reactions: [{ emoji: "👍", users: [{ id: "u", displayName: "U" }] }],
      attachments: [
        {
          id: "att-1",
          messageId: 1,
          filename: "shot.webp",
          mime: "image/webp",
          bytes: 10,
          width: null,
          height: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const out = applyMessageDeletion([target], 1, "2026-08-21T00:00:00.000Z");
    assert.deepEqual(out[0]!.reactions, []);
    assert.deepEqual(out[0]!.attachments, []);
  });

  it("silences every reply quoting it", () => {
    // THE regression. Without this the reply kept displaying the withdrawn text
    // and a thumbnail of the withdrawn image until somebody reloaded.
    const out = applyMessageDeletion([msg(1), withReplyTo(2, 1), withReplyTo(3, 1)], 1, "t");

    for (const reply of [out[1]!, out[2]!]) {
      assert.equal(reply.replyTo!.preview, DELETED_MESSAGE_PREVIEW);
      assert.equal(reply.replyTo!.deleted, true);
      // The thumbnail is the actual leak: its bytes are refused by the download
      // route now, so leaving it renders a broken image at best.
      assert.equal(reply.replyTo!.thumbnailAttachmentId, null);
      assert.equal(reply.replyTo!.attachmentCount, 0);
    }
  });

  it("keeps the reference rather than dropping it", () => {
    // Somebody DID reply to something, the parent row still holds its slot, and
    // the quote stays tappable — it just lands on "Message deleted".
    const out = applyMessageDeletion([msg(1), withReplyTo(2, 1)], 1, "t");
    assert.equal(out[1]!.replyTo!.id, 1);
  });

  it("leaves replies to OTHER messages alone", () => {
    const out = applyMessageDeletion([msg(1), withReplyTo(2, 99)], 1, "t");
    assert.equal(out[1]!.replyTo!.preview, "the original text");
    assert.equal(out[1]!.replyTo!.deleted, false);
  });

  it("leaves unrelated messages untouched", () => {
    const before = [msg(1), msg(2), msg(3)];
    const out = applyMessageDeletion(before, 2, "t");
    assert.deepEqual(out[0], before[0]);
    assert.deepEqual(out[2], before[2]);
  });

  it("is idempotent", () => {
    // A duplicate event, or an event arriving after the acting tab already applied
    // its own optimistic fold, must not keep moving the timestamp.
    const once = applyMessageDeletion([msg(1), withReplyTo(2, 1)], 1, "first");
    const twice = applyMessageDeletion(once, 1, "second");
    assert.deepEqual(twice, once);
    assert.equal(twice[0]!.deletedAt, "first");
  });

  it("does not mutate what it was given", () => {
    const before = [msg(1, "secret"), withReplyTo(2, 1)];
    applyMessageDeletion(before, 1, "t");
    assert.equal(before[0]!.body, "secret");
    assert.equal(before[1]!.replyTo!.preview, "the original text");
  });
});
