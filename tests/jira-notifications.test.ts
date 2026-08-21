import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  jiraNotificationChanges,
  type JiraNotificationTicket,
} from "../lib/jira/notifications.ts";

const ticket = (patch: Partial<JiraNotificationTicket> = {}): JiraNotificationTicket => ({
  ticketId: "GLOP-1",
  status: "IN PROGRESS",
  summary: "Update checkout",
  accountName: "StickerDot",
  branch: "SD_hotfix-1",
  repos: ["backend"],
  userIds: ["person-1"],
  ...patch,
});

describe("jiraNotificationChanges", () => {
  it("notifies only the person newly assigned to a ticket", () => {
    const changes = jiraNotificationChanges(
      [ticket({ userIds: ["person-1"] })],
      [ticket({ userIds: ["person-1", "person-2"] })],
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, "assigned");
    assert.deepEqual(changes[0]?.directoryUserIds, ["person-2"]);
  });

  it("notifies current assignees when their ticket status changes", () => {
    const changes = jiraNotificationChanges(
      [ticket({ status: "IN PROGRESS" })],
      [ticket({ status: "QA TESTING (STG)" })],
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, "status-changed");
    assert.deepEqual(changes[0]?.directoryUserIds, ["person-1"]);
  });

  it("does not duplicate a status alert for someone assigned in the same sync", () => {
    const changes = jiraNotificationChanges(
      [ticket({ status: "TO DO", userIds: [] })],
      [ticket({ status: "IN PROGRESS", userIds: ["person-1"] })],
    );

    assert.deepEqual(changes.map((change) => change.kind), ["assigned"]);
  });

  it("alerts both ticket assignees only when a conflict is newly introduced", () => {
    const second = ticket({ ticketId: "GLOP-2", userIds: ["person-2"] });
    const introduced = jiraNotificationChanges(
      [ticket(), second],
      [ticket(), second, ticket({ ticketId: "GLOP-3", userIds: ["person-3"] })],
    ).filter((change) => change.kind === "conflict");

    assert.equal(introduced.length, 3);
    assert.deepEqual(
      introduced.map((change) => change.ticketId).sort(),
      ["GLOP-1", "GLOP-2", "GLOP-3"],
    );

    const unchanged = jiraNotificationChanges([ticket(), second], [ticket(), second]);
    assert.equal(unchanged.filter((change) => change.kind === "conflict").length, 0);
  });
});
