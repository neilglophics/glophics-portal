/**
 * Access roles — the one list, read by both sides.
 *
 * Ported from AUTH_ROLES in the legacy shared/data.js, which was loaded by the
 * browser *and* required by the server for exactly this reason: what the UI
 * hides and what the server refuses can never drift apart.
 *
 * The UI hides on `roleCan()`. Every route handler checks the same call through
 * `requireUser()`. **Hiding is courtesy; the server is the boundary.** Never add
 * a check that exists only in a component.
 *
 *   view          read the board
 *   claim         assign, force free, edit notes
 *   configure     settings, Jira credentials, the directories
 *   manage-users  create sign-in credentials and hand out roles
 *   chat          send messages  (new — see docs/06-OPEN-QUESTIONS.md Q2)
 *
 * Ordered most-privileged first; the pickers render them in this order.
 */

import type { Capability, RoleId } from "@/lib/types";

export interface Role {
  id: RoleId;
  label: string;
  description: string;
  capabilities: Capability[];
}

export const AUTH_ROLES: readonly Role[] = [
  {
    id: "superadmin",
    label: "Super admin",
    description: "Full access, plus creating sign-in credentials and roles.",
    capabilities: ["view", "claim", "configure", "manage-users", "chat"],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Everything except managing who can sign in.",
    capabilities: ["view", "claim", "configure", "chat"],
  },
  {
    id: "member",
    label: "Member",
    description: "Can claim and free environments, write notes, and chat.",
    capabilities: ["view", "claim", "chat"],
  },
  {
    // Q2 (docs/06-OPEN-QUESTIONS.md): a viewer deliberately has NO `chat`.
    // Sending a message is a write, and "read-only" should mean it. A viewer is
    // often a stakeholder or a shared screen; neither should be able to post.
    // Reversing this is a one-line change — un-sending messages is not.
    id: "viewer",
    label: "Viewer",
    description: "Read-only. Sees the board, changes nothing.",
    capabilities: ["view"],
  },
] as const;

export function getRole(roleId: string | null | undefined): Role | null {
  return AUTH_ROLES.find((r) => r.id === roleId) ?? null;
}

/**
 * An unknown role grants nothing rather than defaulting to something
 * permissive — a typo in a stored role must fail closed.
 */
export function roleCan(roleId: string | null | undefined, capability: Capability): boolean {
  const role = getRole(roleId);
  return !!role && role.capabilities.includes(capability);
}

export function roleLabel(roleId: string | null | undefined): string {
  return getRole(roleId)?.label ?? roleId ?? "Unknown";
}

export function isValidRole(roleId: unknown): roleId is RoleId {
  return typeof roleId === "string" && !!getRole(roleId);
}
