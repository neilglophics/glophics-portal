import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_MIN_INTERVAL_MS,
  HEALTH_STALE_AFTER_MS,
  isPassDue,
  isStale,
  isTooRecent,
  msSinceCheck,
  msUntilDue,
  newestCheck,
  probeHealth,
} from "../lib/shared/health.ts";

/**
 * The health-check policy decides three things that are easy to get subtly
 * wrong and hard to notice: whether a repository is down, whether a pass is
 * owed, and whether what is on screen can still be believed. Each of those has
 * a failure mode the board makes loud — an offline repository outranks every
 * other state — so they are pinned here rather than trusted.
 */

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("probeHealth", () => {
  it("treats any response at all as reachable", () => {
    // Ported reasoning from server/jobs/health.js: a dev storefront answering
    // 404 on / is normal. Only a request that cannot complete means "not there".
    assert.equal(probeHealth("https://dev.example.com/", true), "online");
  });

  it("marks a configured URL that could not be reached offline", () => {
    assert.equal(probeHealth("https://dev.example.com/", false), "offline");
  });

  it("never calls a repository with no URL offline", () => {
    // Nothing to ping is not a failure — and `offline` would outrank claim
    // state and paint an environment red for having been half configured.
    assert.equal(probeHealth("", false), "unconfigured");
    assert.equal(probeHealth(null, false), "unconfigured");
    assert.equal(probeHealth(undefined, true), "unconfigured");
  });
});

describe("newestCheck", () => {
  it("returns the most recent timestamp", () => {
    assert.equal(newestCheck([ago(60_000), ago(10_000), ago(30_000)]), ago(10_000));
  });

  it("ignores nulls and unparseable values rather than treating them as epoch", () => {
    assert.equal(newestCheck([null, undefined, "not a date", ago(5_000)]), ago(5_000));
  });

  it("is null when nothing has ever been checked", () => {
    assert.equal(newestCheck([null, undefined]), null);
    assert.equal(newestCheck([]), null);
  });
});

describe("msSinceCheck", () => {
  it("clamps a future timestamp to zero", () => {
    // A clock skewed forward must read as "just checked", never as a negative
    // age that would make every downstream comparison behave backwards.
    assert.equal(msSinceCheck(new Date(NOW + 60_000).toISOString(), NOW), 0);
  });

  it("is null for a check that never happened", () => {
    assert.equal(msSinceCheck(null, NOW), null);
  });
});

describe("isPassDue", () => {
  it("is due when nothing has ever been checked", () => {
    assert.equal(isPassDue(null, NOW), true);
  });

  it("is not due inside the interval", () => {
    assert.equal(isPassDue(ago(HEALTH_CHECK_INTERVAL_MS - 60_000), NOW), false);
  });

  it("is due once the interval has elapsed", () => {
    assert.equal(isPassDue(ago(HEALTH_CHECK_INTERVAL_MS), NOW), true);
    assert.equal(isPassDue(ago(HEALTH_CHECK_INTERVAL_MS + 1), NOW), true);
  });
});

describe("msUntilDue", () => {
  it("is zero when a pass is owed, so it can be handed to a timer directly", () => {
    assert.equal(msUntilDue(null, NOW), 0);
    assert.equal(msUntilDue(ago(HEALTH_CHECK_INTERVAL_MS * 2), NOW), 0);
  });

  it("counts down the remainder of the interval", () => {
    assert.equal(msUntilDue(ago(HEALTH_CHECK_INTERVAL_MS - 60_000), NOW), 60_000);
  });
});

describe("isTooRecent", () => {
  it("suppresses an unforced pass just after another one", () => {
    assert.equal(isTooRecent(ago(HEALTH_MIN_INTERVAL_MS - 1), NOW), true);
  });

  it("allows one once the floor has passed", () => {
    assert.equal(isTooRecent(ago(HEALTH_MIN_INTERVAL_MS), NOW), false);
  });

  it("never suppresses the first pass of all", () => {
    assert.equal(isTooRecent(null, NOW), false);
  });
});

describe("isStale", () => {
  it("does not cry stale over a single missed pass", () => {
    // One missed scheduled pass is a cold start or a skipped tick. Warning on
    // that trains people to ignore the warning.
    assert.equal(isStale(ago(HEALTH_CHECK_INTERVAL_MS + 60_000), NOW), false);
  });

  it("is stale once two passes' worth of time has gone by", () => {
    assert.equal(isStale(ago(HEALTH_STALE_AFTER_MS + 1), NOW), true);
  });

  it("is not stale when no check has ever run", () => {
    // "Never checked" is a different statement from "the checks have stopped",
    // and the page shows a different notice for each.
    assert.equal(isStale(null, NOW), false);
  });
});
