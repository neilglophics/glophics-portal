import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MESSAGE_COUNTER_THRESHOLD,
  MESSAGE_MAX_LENGTH,
  isOverLimit,
  messageLength,
} from "../lib/chat/limits.ts";

/**
 * The composer and the send route both count with messageLength, so these tests
 * guard the one property that matters: the number a user is shown and the number
 * the server enforces are the same number. If they diverge, somebody is told
 * their message is 2000 characters and then refused for being 2004.
 */

describe("messageLength counts what a person sees", () => {
  it("counts plain text like .length does", () => {
    assert.equal(messageLength("hello"), 5);
    assert.equal(messageLength(""), 0);
  });

  it("counts an emoji as ONE character, not two", () => {
    // "👍".length is 2 in JavaScript. A counter using that tells somebody a
    // single thumbs-up used two of their allowance.
    assert.equal("👍".length, 2);
    assert.equal(messageLength("👍"), 1);
  });

  it("counts a family emoji as one, not seven", () => {
    const family = "👨‍👩‍👧‍👦";
    assert.ok(family.length > 7, `expected a long code-unit length, got ${family.length}`);
    assert.equal(messageLength(family), 1);
  });

  it("counts a flag as one", () => {
    assert.equal(messageLength("🇵🇭"), 1);
  });

  it("counts a combining accent as one", () => {
    // "e" + combining acute — two code points, one character to a reader.
    assert.equal(messageLength("é"), 1);
  });

  it("counts a newline", () => {
    assert.equal(messageLength("a\nb"), 3);
  });
});

describe("isOverLimit", () => {
  it("allows exactly the limit", () => {
    assert.equal(isOverLimit("a".repeat(MESSAGE_MAX_LENGTH)), false);
  });

  it("refuses one past it", () => {
    assert.equal(isOverLimit("a".repeat(MESSAGE_MAX_LENGTH + 1)), true);
  });

  it("measures emoji by the same rule, so the limit is not secretly halved", () => {
    // A message of exactly the limit in emoji must pass. With a naive .length it
    // would read as double and be refused.
    assert.equal(isOverLimit("👍".repeat(MESSAGE_MAX_LENGTH)), false);
    assert.equal(isOverLimit("👍".repeat(MESSAGE_MAX_LENGTH + 1)), true);
  });

  it("allows an empty string — emptiness is a separate check", () => {
    assert.equal(isOverLimit(""), false);
  });
});

describe("the counter threshold", () => {
  it("sits below the limit, so the warning arrives before the wall", () => {
    assert.ok(MESSAGE_COUNTER_THRESHOLD < MESSAGE_MAX_LENGTH);
    assert.ok(MESSAGE_COUNTER_THRESHOLD > 0);
  });

  it("is high enough that ordinary messages never show a counter", () => {
    // A couple of sentences should not put a number on screen.
    assert.ok(messageLength("Server 03 is free now, backend included.") < MESSAGE_COUNTER_THRESHOLD);
  });
});
