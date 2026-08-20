import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findServerForTicket,
  matchRepositoriesToKeys,
  matchUserIdsByLabels,
  statusFrees,
  statusIn,
  statusIsTerminal,
  userJiraNames,
} from "../lib/jira/matching.ts";
import { roleCan } from "../lib/shared/roles.ts";
import type { Account, DirectoryUser, Environment } from "../lib/types.ts";

/**
 * The Jira rules. These are the parts of the port most likely to break something
 * silently, because a wrong answer here shows up as a booking that never clears
 * or an environment claimed by the wrong ticket.
 */

const JIRA = {
  occupyingStatuses: ["QA TESTING (DEV)", "QA TESTING (STG)"],
  releasingStatuses: ["FINAL CHECKING", "DONE"],
};

describe("status rules", () => {
  it("matches case-insensitively, because Jira reports its own casing", () => {
    assert.equal(statusIn(JIRA.occupyingStatuses, "qa testing (dev)"), true);
    assert.equal(statusIn(JIRA.occupyingStatuses, "  QA Testing (Dev)  "), true);
    assert.equal(statusIn(JIRA.occupyingStatuses, "QA FAILED"), false);
  });

  it("frees on a configured releasing status", () => {
    assert.equal(statusFrees(JIRA, "FINAL CHECKING"), true);
  });

  it("frees on a terminal status whatever the lists say", () => {
    // A cancelled or closed ticket is nobody's work in progress, and leaving an
    // environment held in its name is a booking nothing will come back to clear.
    for (const status of ["DONE", "CLOSED", "CANCELLED"]) {
      assert.equal(statusFrees({ releasingStatuses: [] }, status), true, status);
      assert.equal(statusIsTerminal(status), true, status);
    }
  });

  it("KEEPS the claim on QA FAILED — the ticket bounced back, it is still being worked", () => {
    // This is the stickiness rule. If it ever returns true, every failed QA pass
    // silently hands the environment to somebody else.
    assert.equal(statusFrees(JIRA, "QA FAILED"), false);
  });

  it("keeps the claim on any other unlisted status", () => {
    for (const status of ["IN PROGRESS", "ON HOLD", "LIVE DEPLOYMENT", "TO REVIEW"]) {
      assert.equal(statusFrees(JIRA, status), false, status);
    }
  });
});

describe("matchRepositoriesToKeys", () => {
  const keys = ["storefront", "backend", "admin"];

  it("translates the known synonyms", () => {
    assert.deepEqual(matchRepositoriesToKeys(["API"], keys).matched, ["backend"]);
    assert.deepEqual(matchRepositoriesToKeys(["Frontend"], keys).matched, ["storefront"]);
    assert.deepEqual(matchRepositoriesToKeys(["admin"], keys).matched, ["admin"]);
  });

  it("reports an unknown label rather than guessing", () => {
    const result = matchRepositoriesToKeys(["mobile"], keys);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, ["mobile"]);
  });

  it("will not match a repo the environment does not have", () => {
    assert.deepEqual(matchRepositoriesToKeys(["admin"], ["storefront"]).matched, []);
  });
});

describe("matchUserIdsByLabels", () => {
  const people: DirectoryUser[] = [
    { id: "sem", name: "[BE]_Sem", jobRole: "Backend", jiraNames: ["[BE]_Sem", "[BE]_Sem_R"] },
    { id: "jerome", name: "[QA]_Jerome", jobRole: "QA", jiraNames: [] },
  ];

  it("matches any of a person's several labels", () => {
    assert.deepEqual(matchUserIdsByLabels(["[BE]_Sem_R"], people).matched, ["sem"]);
  });

  it("falls back to the display name when no labels are set", () => {
    assert.deepEqual(userJiraNames(people[1]!), ["[QA]_Jerome"]);
    assert.deepEqual(matchUserIdsByLabels(["[QA]_Jerome"], people).matched, ["jerome"]);
  });

  it("reports a label that matched nobody instead of dropping it", () => {
    // A label with no person behind it is a ticket nobody can find as theirs,
    // which is exactly what the Users page coverage notice is built on.
    const result = matchUserIdsByLabels(["[FE]_Nobody"], people);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, ["[FE]_Nobody"]);
  });

  it("does not list the same person twice", () => {
    assert.deepEqual(matchUserIdsByLabels(["[BE]_Sem", "[BE]_Sem_R"], people).matched, ["sem"]);
  });
});

describe("findServerForTicket", () => {
  const accounts: Account[] = [
    { id: "sticker-market", displayName: "Sticker Market", repositories: ["backend"] },
  ];
  const environments: Environment[] = [
    {
      id: "server-03",
      name: "Server 03",
      accountId: "sticker-market",
      repos: [{ repoName: "backend", url: "", health: "unconfigured", healthCheckedAt: null, note: null }],
    },
  ];

  it("matches account and branch case-insensitively but exactly", () => {
    const result = findServerForTicket(
      { accountName: "sticker market", branch: "server 03" },
      accounts,
      environments,
    );
    assert.ok("server" in result);
    assert.equal(result.server.id, "server-03");
  });

  it("refuses a near miss rather than guessing", () => {
    // No fuzzy matching: "Server 3" is not "Server 03".
    const result = findServerForTicket(
      { accountName: "Sticker Market", branch: "Server 3" },
      accounts,
      environments,
    );
    assert.ok("error" in result);
    assert.match(result.error, /No environment named/);
  });

  it("names the missing field so Not-tracked can say what to fix", () => {
    assert.match(
      (findServerForTicket({ accountName: "", branch: "x" }, accounts, environments) as { error: string })
        .error,
      /Account Name is empty/,
    );
    assert.match(
      (findServerForTicket({ accountName: "x", branch: "" }, accounts, environments) as { error: string })
        .error,
      /Branch is empty/,
    );
  });
});

describe("roleCan", () => {
  it("grants what the documented table says", () => {
    assert.equal(roleCan("superadmin", "manage-users"), true);
    assert.equal(roleCan("admin", "manage-users"), false);
    assert.equal(roleCan("admin", "configure"), true);
    assert.equal(roleCan("member", "configure"), false);
    assert.equal(roleCan("member", "claim"), true);
    assert.equal(roleCan("viewer", "claim"), false);
    assert.equal(roleCan("viewer", "view"), true);
  });

  it("gives a viewer no chat, per docs/06 Q2", () => {
    assert.equal(roleCan("viewer", "chat"), false);
    assert.equal(roleCan("member", "chat"), true);
  });

  it("fails closed on an unknown or absent role", () => {
    // A typo in a stored role must grant nothing rather than default to
    // something permissive.
    assert.equal(roleCan("superadmın", "view"), false); // dotless i
    assert.equal(roleCan(undefined, "view"), false);
    assert.equal(roleCan("", "view"), false);
  });
});
