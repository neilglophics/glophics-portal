import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookingIsContradictory, bookingWindow, endInstant, startInstant } from "../lib/jira/booking.ts";

/**
 * The window a ticket books.
 *
 * This is tested rather than trusted because the interesting cases are only
 * reachable through a ticket somebody mistyped in Jira, and the failure they
 * caused was total: `claims_time_order` rejected the row, applySync() writes in
 * ONE transaction, and so a single bad ticket rolled back every other ticket in
 * the pass. The board stopped updating and the only sign was a constraint name
 * in a 500. GLOP-1533 — start 2026-08-26, due 2026-08-18 — is the real one.
 */

const NOW = "2026-08-26T04:00:00.000Z";

describe("bookingWindow", () => {
  it("keeps both dates when they make sense", () => {
    const { startTime, endTime } = bookingWindow("2026-08-18", "2026-08-20");
    assert.equal(startTime, startInstant("2026-08-18"));
    assert.equal(endTime, endInstant("2026-08-20"));
  });

  it("keeps a same-day booking, which runs 09:00 to 18:00", () => {
    const { startTime, endTime } = bookingWindow("2026-08-18", "2026-08-18");
    assert.ok(startTime && endTime && endTime > startTime);
  });

  it("keeps a due date in the past — overdue is real information", () => {
    // The one case that must NOT be treated as a contradiction: the dates agree
    // with each other, they are just both behind us.
    const { startTime, endTime } = bookingWindow("2026-08-01", "2026-08-05", NOW);
    assert.equal(startTime, startInstant("2026-08-01"));
    assert.equal(endTime, endInstant("2026-08-05"));
  });

  it("drops the END when Jira's own two dates contradict each other", () => {
    // GLOP-1533. The ticket is at an occupying status, so it IS held; what we
    // do not know is when it frees.
    const { startTime, endTime } = bookingWindow("2026-08-26", "2026-08-18", NOW);
    assert.equal(startTime, startInstant("2026-08-26"));
    assert.equal(endTime, null);
  });

  it("drops OUR invented start rather than Jira's real due date", () => {
    // No start date, so the caller falls back to "it started now" — which
    // collides with any due date in the past. The fallback is the wrong value
    // here, so the fallback is what gives way and the board can still say
    // overdue.
    const { startTime, endTime } = bookingWindow(null, "2026-08-18", NOW);
    assert.equal(startTime, null);
    assert.equal(endTime, endInstant("2026-08-18"));
  });

  it("keeps the invented start when it does not collide", () => {
    const { startTime, endTime } = bookingWindow(null, "2026-09-30", NOW);
    assert.equal(startTime, NOW);
    assert.equal(endTime, endInstant("2026-09-30"));
  });

  it("never invents a start for a ticket that holds nothing", () => {
    // record() passes no fallback: a row in the Jira cache is not a booking.
    assert.deepEqual(bookingWindow(null, null), { startTime: null, endTime: null });
    assert.deepEqual(bookingWindow(null, "2026-08-18"), {
      startTime: null,
      endTime: endInstant("2026-08-18"),
    });
  });

  it("always returns something claims_time_order accepts", () => {
    // The property the whole function exists for, over every shape of input.
    const dates = [null, "2026-08-01", "2026-08-18", "2026-08-26", "2026-09-30"];
    for (const start of dates) {
      for (const due of dates) {
        for (const fallback of [null, NOW]) {
          const { startTime, endTime } = bookingWindow(start, due, fallback);
          assert.ok(
            endTime === null || startTime === null || endTime > startTime,
            `start=${start} due=${due} fallback=${fallback} -> ${startTime} / ${endTime}`,
          );
        }
      }
    }
  });
});

describe("bookingIsContradictory", () => {
  it("is true only when both dates exist and disagree", () => {
    assert.equal(bookingIsContradictory("2026-08-26", "2026-08-18"), true);
    assert.equal(bookingIsContradictory("2026-08-18", "2026-08-26"), false);
    assert.equal(bookingIsContradictory("2026-08-18", "2026-08-18"), false);
    // A missing date is not a contradiction — there is nothing to contradict,
    // and warning about it would cry wolf on every ticket with no due date.
    assert.equal(bookingIsContradictory(null, "2026-08-18"), false);
    assert.equal(bookingIsContradictory("2026-08-18", null), false);
    assert.equal(bookingIsContradictory(null, null), false);
  });
});
