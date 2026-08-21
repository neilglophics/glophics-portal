import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jiraBranchConflicts, type JiraConflictCandidate } from "../lib/shared/jira-conflicts.ts";

const ticket = (patch: Partial<JiraConflictCandidate> = {}): JiraConflictCandidate => ({
  ticketId: "GLOP-1",
  status: "IN PROGRESS",
  accountName: "StickerDot",
  branch: "SD_hotfix-1",
  repos: ["backend"],
  ...patch,
});

describe("jiraBranchConflicts", () => {
  it("flags both tickets when account, branch, and any repository overlap", () => {
    const conflicts = jiraBranchConflicts([
      ticket(),
      ticket({
        ticketId: "GLOP-2",
        status: "qa testing (stg)",
        accountName: "stickerdot",
        branch: "sd_HOTFIX-1",
        repos: ["storefront", "BACKEND"],
      }),
    ]);

    assert.deepEqual(conflicts.get("GLOP-1"), { ticketIds: ["GLOP-2"], repos: ["backend"] });
    assert.deepEqual(conflicts.get("GLOP-2"), { ticketIds: ["GLOP-1"], repos: ["backend"] });
  });

  it("does not flag a different account, branch, repository, or status", () => {
    const conflicts = jiraBranchConflicts([
      ticket(),
      ticket({ ticketId: "ACCOUNT", accountName: "StickerMarket" }),
      ticket({ ticketId: "BRANCH", branch: "SD_hotfix-2" }),
      ticket({ ticketId: "REPO", repos: ["storefront"] }),
      ticket({ ticketId: "STATUS", status: "FINAL CHECKING" }),
    ]);

    assert.equal(conflicts.size, 0);
  });

  it("checks tickets outside the visible five-row dashboard limit", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      ticket({
        ticketId: `GLOP-${index + 1}`,
        branch: index === 0 || index === 5 ? "SD_hotfix-shared" : `SD_hotfix-${index}`,
      }),
    );

    const conflicts = jiraBranchConflicts(candidates);
    assert.deepEqual(conflicts.get("GLOP-1")?.ticketIds, ["GLOP-6"]);
  });
});
