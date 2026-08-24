import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPO_BADGE, repoBadgeState } from "../lib/shared/tokens.ts";
import type { ServerRepo } from "../lib/types.ts";

/**
 * The repository badge on a ticket row is the one place occupancy and health
 * are shown in a single mark, so its precedence has to match the board's — an
 * offline repository that read "occupied" would send somebody to deploy against
 * a box that is down. Invariant 1, in badge form.
 */

function repo(patch: Partial<ServerRepo> = {}): ServerRepo {
  return {
    repoName: "storefront",
    url: "https://storefront.example",
    health: "online",
    healthCheckedAt: null,
    note: null,
    ...patch,
  };
}

describe("repoBadgeState", () => {
  it("reads offline even while a ticket is holding it", () => {
    // The whole point of the precedence: amber would hide a down server.
    assert.equal(repoBadgeState(repo({ health: "offline" }), true), "offline");
    assert.equal(repoBadgeState(repo({ health: "offline" }), false), "offline");
  });

  it("says occupied when a claim holds a reachable repository", () => {
    assert.equal(repoBadgeState(repo(), true), "occupied");
  });

  it("says free when it is reachable and nobody is on it", () => {
    assert.equal(repoBadgeState(repo(), false), "free");
  });

  it("never claims to know about a repository with no URL", () => {
    // Nothing has ever been checked, so "free" would be a guess dressed as a
    // fact — even when no claim holds it.
    assert.equal(repoBadgeState(repo({ url: "", health: "unconfigured" }), false), "unknown");
    assert.equal(repoBadgeState(repo({ url: "" }), false), "unknown");
  });

  it("still reports occupancy honestly on a slot with no URL", () => {
    // Held outranks nothing here — unknown is about reachability, and a claim
    // on an uncheckable slot is still a claim. It reads unknown, and the
    // holders list beside it is what says who has it.
    assert.equal(repoBadgeState(repo({ url: "", health: "unconfigured" }), true), "unknown");
  });

  it("falls back to unknown when the ticket matched no environment", () => {
    // The Not-tracked case: we do not know which box the ticket meant, so the
    // badge does not guess one.
    assert.equal(repoBadgeState(undefined, false), "unknown");
    assert.equal(repoBadgeState(undefined, true), "unknown");
  });

  it("has a token, a dot and a word for every state", () => {
    for (const state of ["offline", "occupied", "free", "unknown"] as const) {
      const token = REPO_BADGE[state];
      assert.ok(token.word.length, `${state} needs a word for the tooltip`);
      assert.ok(token.chip.length, `${state} needs a chip class`);
      assert.ok(token.dot.length, `${state} needs a dot class`);
    }
  });
});
