import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayStatus, boardSummary, repoClaims, isRepoHeld } from "../lib/shared/occupancy.ts";
import type { Claim, Environment } from "../lib/types.ts";

/**
 * Occupancy is the rule the whole product rests on, and it is derived rather
 * than stored — so a mistake here silently mislabels every environment. These
 * cases are the ones the legacy comments called out by name.
 */

function env(id: string, repos: [string, "online" | "offline" | "unconfigured"][]): Environment {
  return {
    id,
    name: id,
    accountId: "acct",
    repos: repos.map(([repoName, health]) => ({
      repoName,
      url: health === "unconfigured" ? "" : `https://${repoName}.example`,
      health,
      healthCheckedAt: null,
      note: null,
    })),
  };
}

function claim(id: string, serverId: string, repos: string[], endTime: string | null = null): Claim {
  return {
    id,
    source: "manual",
    serverId,
    accountName: "Acct",
    branch: serverId,
    repos,
    userIds: ["sem"],
    rawAssignees: [],
    status: "Manual",
    summary: null,
    note: null,
    startTime: null,
    endTime,
    claimedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: null,
    jiraCreatedAt: null,
    jiraUpdatedAt: null,
  };
}

const THREE: [string, "online"][] = [
  ["storefront", "online"],
  ["backend", "online"],
  ["admin", "online"],
];

describe("displayStatus", () => {
  it("is free with no claims", () => {
    assert.equal(displayStatus(env("s1", THREE), []), "free");
  });

  it("is partial when some repos are held", () => {
    assert.equal(displayStatus(env("s1", THREE), [claim("c1", "s1", ["backend"])]), "partial");
  });

  it("is inuse when every repo is held", () => {
    const claims = [claim("c1", "s1", ["storefront", "backend"]), claim("c2", "s1", ["admin"])];
    assert.equal(displayStatus(env("s1", THREE), claims), "inuse");
  });

  it("lets an offline repo outrank every claim state", () => {
    // The legacy rule: "Needs attention" matters more than whether it's booked.
    const offline = env("s1", [
      ["storefront", "online"],
      ["backend", "offline"],
      ["admin", "online"],
    ]);
    assert.equal(displayStatus(offline, []), "issue", "offline outranks free");
    assert.equal(
      displayStatus(offline, [claim("c1", "s1", ["storefront", "backend", "admin"])]),
      "issue",
      "offline outranks inuse",
    );
  });

  it("ignores claims belonging to another environment", () => {
    assert.equal(displayStatus(env("s1", THREE), [claim("c1", "s2", ["backend"])]), "free");
  });

  it("counts a repo held by two claims once — 'Shared' is still one repo", () => {
    const claims = [claim("c1", "s1", ["backend"]), claim("c2", "s1", ["backend"])];
    assert.equal(displayStatus(env("s1", THREE), claims), "partial");
    assert.equal(repoClaims(claims, "s1", "backend").length, 2);
    assert.equal(isRepoHeld(claims, "s1", "backend"), true);
    assert.equal(isRepoHeld(claims, "s1", "admin"), false);
  });

  it("treats an unconfigured repo as claimable, not as broken", () => {
    const partly = env("s1", [
      ["storefront", "online"],
      ["backend", "unconfigured"],
    ]);
    assert.equal(displayStatus(partly, []), "free");
  });
});

describe("boardSummary", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const inOneHour = new Date(now + 3600_000).toISOString();
  const inThreeHours = new Date(now + 3 * 3600_000).toISOString();

  it("counts free, partial, and inuse as the legacy page did", () => {
    const environments = [env("s1", THREE), env("s2", THREE), env("s3", THREE)];
    const claims = [claim("c1", "s2", ["backend"]), claim("c2", "s3", ["storefront", "backend", "admin"])];

    const summary = boardSummary(environments, claims, now);
    assert.equal(summary.total, 3);
    assert.equal(summary.free, 1);
    assert.equal(summary.partial, 1);
    // "inuse" is deliberately everything-not-free, matching the legacy tile.
    assert.equal(summary.inuse, 2);
    assert.equal(summary.claimsCount, 2);
  });

  it("counts freeingSoon only inside the two-hour window", () => {
    const environments = [env("s1", THREE), env("s2", THREE)];
    const claims = [claim("c1", "s1", ["backend"], inOneHour), claim("c2", "s2", ["backend"], inThreeHours)];

    assert.equal(boardSummary(environments, claims, now).freeingSoon, 1);
  });

  it("does not count an already-expired claim as freeing soon", () => {
    const past = new Date(now - 60_000).toISOString();
    const claims = [claim("c1", "s1", ["backend"], past)];
    assert.equal(boardSummary([env("s1", THREE)], claims, now).freeingSoon, 0);
  });

  it("counts held repositories, not claims", () => {
    const claims = [claim("c1", "s1", ["storefront", "backend"])];
    assert.equal(boardSummary([env("s1", THREE)], claims, now).reposHeld, 2);
  });
});
