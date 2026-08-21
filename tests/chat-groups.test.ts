import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GROUP_NAME_MAX_LENGTH,
  canManageGroup,
  canManageRoles,
  canRemoveMember,
  isMemberRole,
  normalizeGroupName,
  successorTo,
  systemMessageBody,
  type MemberRole,
} from "../lib/chat/groups.ts";

/**
 * The group permission model is read twice — by the browser to hide a button and
 * by the route handler to refuse one. These functions are the single copy both
 * sides call, so a bug here is a bug on both sides at once: a UI that offers what
 * the server refuses, or worse, a server that allows what the UI merely happened
 * not to offer.
 */

const ROLES: MemberRole[] = ["owner", "admin", "member"];

describe("isMemberRole", () => {
  it("accepts the three, and nothing else", () => {
    for (const role of ROLES) assert.equal(isMemberRole(role), true);
    // Fails closed. A typo in a stored role must grant nothing.
    for (const value of ["Owner", "superadmin", "", null, undefined, 1])
      assert.equal(isMemberRole(value), false, `${String(value)} should be refused`);
  });
});

describe("canManageGroup", () => {
  it("is the owner and admins", () => {
    assert.equal(canManageGroup("owner"), true);
    assert.equal(canManageGroup("admin"), true);
    assert.equal(canManageGroup("member"), false);
    // Not a member of this group at all.
    assert.equal(canManageGroup(null), false);
  });
});

describe("canManageRoles", () => {
  it("is the owner alone", () => {
    // An admin who could appoint admins could appoint enough of them to outvote
    // the owner in every practical sense.
    assert.equal(canManageRoles("owner"), true);
    assert.equal(canManageRoles("admin"), false);
    assert.equal(canManageRoles("member"), false);
    assert.equal(canManageRoles(null), false);
  });
});

describe("canRemoveMember", () => {
  it("never lets anybody remove themselves", () => {
    // That is leaving, which writes a different line in the history and, for an
    // owner, arranges a succession.
    for (const actor of ROLES) {
      assert.equal(
        canRemoveMember(actor, actor, { samePerson: true }),
        false,
        `${actor} should not be able to remove themselves`,
      );
    }
  });

  it("never lets anybody remove the owner", () => {
    for (const actor of ROLES) {
      assert.equal(canRemoveMember(actor, "owner", { samePerson: false }), false);
    }
  });

  it("lets the owner remove admins and members", () => {
    assert.equal(canRemoveMember("owner", "admin", { samePerson: false }), true);
    assert.equal(canRemoveMember("owner", "member", { samePerson: false }), true);
  });

  it("lets an admin remove members but not other admins", () => {
    // Peers ejecting peers is a race with no correct outcome, and the owner is
    // right there.
    assert.equal(canRemoveMember("admin", "member", { samePerson: false }), true);
    assert.equal(canRemoveMember("admin", "admin", { samePerson: false }), false);
  });

  it("lets a plain member remove nobody", () => {
    for (const target of ROLES) {
      assert.equal(canRemoveMember("member", target, { samePerson: false }), false);
      assert.equal(canRemoveMember(null, target, { samePerson: false }), false);
    }
  });
});

describe("successorTo", () => {
  const members = [
    { userId: "owner", role: "owner" as MemberRole, joinedAt: "2026-01-01T00:00:00.000Z" },
    { userId: "newAdmin", role: "admin" as MemberRole, joinedAt: "2026-05-01T00:00:00.000Z" },
    { userId: "oldAdmin", role: "admin" as MemberRole, joinedAt: "2026-02-01T00:00:00.000Z" },
    { userId: "oldMember", role: "member" as MemberRole, joinedAt: "2026-01-15T00:00:00.000Z" },
  ];

  it("prefers the longest-standing admin", () => {
    // Not the longest-standing PERSON: oldMember joined before either admin, and
    // is still not the one who inherits.
    assert.equal(successorTo("owner", members), "oldAdmin");
  });

  it("falls back to the longest-standing member when there are no admins", () => {
    const noAdmins = members
      .filter((m) => m.role !== "admin")
      .concat({ userId: "newMember", role: "member", joinedAt: "2026-06-01T00:00:00.000Z" });
    assert.equal(successorTo("owner", noAdmins), "oldMember");
  });

  it("never returns the person leaving", () => {
    assert.notEqual(successorTo("oldAdmin", members), "oldAdmin");
  });

  it("returns null when the leaver is the last one out", () => {
    // The caller deletes the conversation rather than leaving an ownerless husk
    // that the unique index means nothing can ever fix.
    assert.equal(
      successorTo("owner", [{ userId: "owner", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" }]),
      null,
    );
  });
});

describe("normalizeGroupName", () => {
  it("trims and collapses whitespace", () => {
    // "QA   team" and "QA team" being two different groups is a bug report
    // waiting to happen, and padding a name with spaces to sort it higher is a
    // thing people do.
    const result = normalizeGroupName("  QA   coordination \n team ");
    assert.deepEqual(result, { ok: true, name: "QA coordination team" });
  });

  it("refuses an empty or whitespace-only name", () => {
    for (const value of ["", "   ", "\n\t", null, undefined]) {
      const result = normalizeGroupName(value);
      assert.equal(result.ok, false);
    }
  });

  it("refuses one over the limit and says by how much", () => {
    const result = normalizeGroupName("x".repeat(GROUP_NAME_MAX_LENGTH + 1));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, new RegExp(String(GROUP_NAME_MAX_LENGTH)));
  });

  it("accepts one exactly at the limit", () => {
    const result = normalizeGroupName("x".repeat(GROUP_NAME_MAX_LENGTH));
    assert.equal(result.ok, true);
  });
});

describe("systemMessageBody", () => {
  it("reads as a sentence for every event", () => {
    assert.equal(systemMessageBody("group.created", "Alex"), "Alex created the group");
    assert.equal(
      systemMessageBody("group.renamed", "Alex", { groupName: "QA" }),
      'Alex changed the group name to "QA"',
    );
    assert.equal(systemMessageBody("group.avatar", "Alex"), "Alex changed the group photo");
    assert.equal(
      systemMessageBody("member.added", "Alex", { targetName: "Jamie" }),
      "Alex added Jamie",
    );
    assert.equal(
      systemMessageBody("member.removed", "Alex", { targetName: "Jamie" }),
      "Alex removed Jamie",
    );
    assert.equal(systemMessageBody("member.left", "Jamie"), "Jamie left the group");
    assert.equal(
      systemMessageBody("member.role", "Alex", { targetName: "Jamie", role: "admin" }),
      "Alex made Jamie an admin",
    );
    assert.equal(
      systemMessageBody("member.role", "Alex", { targetName: "Jamie", role: "member" }),
      "Alex removed Jamie as an admin",
    );
  });

  it("never says somebody removed themselves", () => {
    // "Jamie removed Jamie" reads like something went wrong; leaving is its own
    // event for exactly this reason.
    assert.equal(systemMessageBody("member.left", "Jamie", { targetName: "Jamie" }), "Jamie left the group");
  });

  it("degrades to a placeholder rather than printing undefined", () => {
    assert.equal(systemMessageBody("member.added", "Alex"), "Alex added someone");
  });
});
