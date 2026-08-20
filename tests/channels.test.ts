import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOARD_CHANNEL,
  ORG_PRESENCE_CHANNEL,
  conversationChannel,
  parseChannel,
  userChannel,
} from "../lib/realtime/channels.ts";

/**
 * The channel parser is the first half of the most security-critical path in the
 * app: /api/pusher/auth decides who may listen to what based entirely on what
 * this returns. A wrong answer here hands live private messages to a subscriber,
 * and no amount of correct SQL elsewhere would catch it.
 *
 * So these tests are mostly about what it must REFUSE.
 */

const UUID_A = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("parseChannel — accepts", () => {
  it("the board channel", () => {
    assert.deepEqual(parseChannel(BOARD_CHANNEL), { kind: "board" });
  });

  it("the org presence channel", () => {
    assert.deepEqual(parseChannel(ORG_PRESENCE_CHANNEL), { kind: "presence" });
  });

  it("a user channel, round-tripped through its builder", () => {
    assert.deepEqual(parseChannel(userChannel(UUID_A)), { kind: "user", userId: UUID_A });
  });

  it("a conversation channel, round-tripped through its builder", () => {
    assert.deepEqual(parseChannel(conversationChannel(UUID_B)), {
      kind: "conversation",
      conversationId: UUID_B,
    });
  });
});

describe("parseChannel — refuses (default deny)", () => {
  it("an unknown name", () => {
    assert.equal(parseChannel("private-something-else"), null);
    assert.equal(parseChannel("board"), null);
    assert.equal(parseChannel(""), null);
  });

  it("a PUBLIC channel of any kind", () => {
    // Nothing in this app is public. The app key ships in the browser bundle by
    // design, so a public channel is readable by anyone who views source.
    assert.equal(parseChannel("board"), null);
    assert.equal(parseChannel("user-" + UUID_A), null);
    assert.equal(parseChannel("conv-" + UUID_B), null);
  });

  it("an id that is not a uuid", () => {
    // A crafted id must not reach whatever compares it downstream.
    assert.equal(parseChannel("private-user-admin"), null);
    assert.equal(parseChannel("private-user-*"), null);
    assert.equal(parseChannel("private-user-1"), null);
    assert.equal(parseChannel("private-conv-%2E%2E"), null);
    assert.equal(parseChannel("private-conv-'; DROP TABLE chat_messages; --"), null);
  });

  it("a uuid with anything appended or prepended", () => {
    // The regex is anchored, so a valid uuid embedded in a longer string is not
    // a valid channel.
    assert.equal(parseChannel(`private-user-${UUID_A}x`), null);
    assert.equal(parseChannel(`private-user-x${UUID_A}`), null);
    assert.equal(parseChannel(`private-user-${UUID_A}/${UUID_B}`), null);
  });

  it("a prefix of a real id — the bug an exact comparison exists to prevent", () => {
    // `private-user-<prefix>` must never parse as the longer id's channel. This
    // is why /api/pusher/auth compares ids exactly rather than with startsWith.
    const prefix = UUID_A.slice(0, 30);
    assert.equal(parseChannel(`private-user-${prefix}`), null);
  });
});

describe("parseChannel — user channels are distinct per person", () => {
  it("gives two people two different channel names", () => {
    assert.notEqual(userChannel(UUID_A), userChannel(UUID_B));
  });

  it("parses each back to its own id, never the other", () => {
    const a = parseChannel(userChannel(UUID_A));
    assert.ok(a && a.kind === "user");
    assert.equal(a.userId, UUID_A);
    assert.notEqual(a.userId, UUID_B);
  });
});
