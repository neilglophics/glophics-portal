import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELTA_OVERLAP_MINUTES,
  FULL_WINDOW_MINUTES,
  SYNC_WINDOW,
  buildJql,
  planPass,
} from "../lib/jira/pass.ts";

/**
 * How much of Jira one pass asks for.
 *
 * This is tested here rather than by running a sync because a sync needs a live
 * Jira and a live database, and the rule it would be checking is arithmetic over
 * two timestamps. Getting that arithmetic wrong is quiet in both directions and
 * expensive in both: a window too narrow silently misses updates and leaves the
 * board wrong with no error anywhere, and one too wide re-reads the whole
 * backlog every minute, which is the cost this change exists to remove.
 */

const MINUTE = 60_000;
const now = Date.UTC(2026, 7, 26, 12, 0, 0);
const minutesAgo = (n: number) => new Date(now - n * MINUTE).toISOString();

describe("planPass", () => {
  it("asks for everything when it is told to", () => {
    assert.deepEqual(planPass("full", minutesAgo(1), now), { mode: "full", window: SYNC_WINDOW });
  });

  it("asks for everything on a first sync, having nothing to be incremental from", () => {
    assert.equal(planPass("auto", null, now).mode, "full");
  });

  it("asks only for what changed since the last pass", () => {
    const pass = planPass("auto", minutesAgo(1), now);
    assert.equal(pass.mode, "delta");
    assert.equal(pass.window, `updated >= -${1 + DELTA_OVERLAP_MINUTES}m`);
  });

  it("overlaps the last pass rather than starting exactly where it stopped", () => {
    // The hole this closes: an update landing between the search and the write.
    // Without the overlap the next pass starts after it and never sees it.
    const pass = planPass("auto", minutesAgo(0), now);
    assert.equal(pass.window, `updated >= -${DELTA_OVERLAP_MINUTES}m`);
  });

  it("rounds the gap up, never down", () => {
    // 90 seconds is two minutes' worth of window, not one. Rounding down would
    // leave thirty seconds of Jira unread on every single pass.
    const pass = planPass("auto", new Date(now - 90_000).toISOString(), now);
    assert.equal(pass.window, `updated >= -${2 + DELTA_OVERLAP_MINUTES}m`);
  });

  it("falls back to a full pass once the gap is wider than the window itself", () => {
    const stale = new Date(now - (FULL_WINDOW_MINUTES + 1) * MINUTE).toISOString();
    assert.equal(planPass("auto", stale, now).mode, "full");

    // And stays incremental just inside it, so the boundary is a boundary and
    // not a cliff every long-idle deployment falls off.
    const just = new Date(now - (FULL_WINDOW_MINUTES - DELTA_OVERLAP_MINUTES - 1) * MINUTE).toISOString();
    assert.equal(planPass("auto", just, now).mode, "delta");
  });

  it("falls back to a full pass when the clock has gone backwards", () => {
    // A last_sync_at in the future would produce a negative window, and
    // `updated >= --3m` is not a query Jira will answer.
    const future = new Date(now + 60 * MINUTE).toISOString();
    assert.equal(planPass("auto", future, now).mode, "full");
  });

  it("falls back to a full pass on an unparseable timestamp", () => {
    assert.equal(planPass("auto", "not a date", now).mode, "full");
  });

  it("accepts a Date, which is what the driver hands back for timestamptz", () => {
    const pass = planPass("auto", new Date(now - 2 * MINUTE), now);
    assert.equal(pass.mode, "delta");
    assert.equal(pass.window, `updated >= -${2 + DELTA_OVERLAP_MINUTES}m`);
  });
});

describe("buildJql", () => {
  it("carries no status filter — every status reaches the cache (ADR-014)", () => {
    const jql = buildJql(SYNC_WINDOW, []);
    assert.ok(!jql.includes("status"), jql);
    assert.equal(jql, `${SYNC_WINDOW} ORDER BY updated DESC`);
  });

  it("always asks for held keys by name, whatever the window", () => {
    // Rule 2 of the sync, and the thing assertJiraAnswered() leans on: a pass
    // that gets none of these back has not answered.
    const jql = buildJql("updated >= -6m", ["GLOP-1", "GLOP-2"]);
    assert.equal(jql, "(updated >= -6m) OR key IN (GLOP-1, GLOP-2) ORDER BY updated DESC");
  });

  it("parenthesises the window so the OR cannot swallow it", () => {
    // Without the brackets a compound window would bind to `OR key IN (…)` in
    // whatever way Jira felt like, which is the classic way a sync starts
    // quietly returning the wrong set.
    const jql = buildJql("updated >= -6m AND project = GLOP", ["GLOP-1"]);
    assert.ok(jql.startsWith("(updated >= -6m AND project = GLOP) OR key IN"), jql);
  });

  it("orders by updated so the page cap drops the oldest, not the newest", () => {
    assert.ok(buildJql(SYNC_WINDOW, []).endsWith("ORDER BY updated DESC"));
  });
});
