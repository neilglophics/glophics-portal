/**
 * Who may do what inside a group, and the sentences a system message says.
 *
 * ── Why this is a module and not a handful of ifs in route handlers ──
 *
 * The same questions are asked twice: by the browser, to decide whether to show
 * a "Remove" button, and by the route handler, to decide whether to obey one.
 * Splitting that across two implementations is how a UI ends up offering
 * something the server refuses — or, far worse, how a server ends up allowing
 * something the UI merely happened not to offer.
 *
 * **Hiding is courtesy; the server is the boundary.** Same rule as
 * lib/shared/roles.ts, one level down: these functions decide, and every mutation
 * in lib/db/queries/chat.ts calls them before it writes.
 *
 * ── The permission model ──
 *
 *                      owner   admin   member
 *   rename group         ✓       ✓        ✗
 *   change avatar        ✓       ✓        ✗
 *   add members          ✓       ✓        ✗
 *   remove a member      ✓       ✓        ✗
 *   remove an admin      ✓       ✗        ✗
 *   remove the owner     ✗       ✗        ✗     (the owner leaves; see below)
 *   promote / demote     ✓       ✗        ✗
 *   leave                ✓*      ✓        ✓
 *
 *   * the owner's departure hands the title on — see `successorTo`.
 *
 * Two deliberate asymmetries:
 *
 *   - An admin cannot remove another admin. Peers ejecting peers is a race with
 *     no correct outcome, and the owner is right there.
 *   - Nobody can remove the owner, including the owner. Leaving is the owner's
 *     path out, and it transfers the title on the way — so a group can never be
 *     left with nobody able to administer it.
 *
 * A `superadmin` gets no bypass here. Membership is the authorization boundary
 * for chat (see the header of lib/db/queries/chat.ts); a board-wide role that
 * could silently rename other people's groups would be a second, unlogged one.
 */

export type MemberRole = "owner" | "admin" | "member";

export function isMemberRole(value: unknown): value is MemberRole {
  return value === "owner" || value === "admin" || value === "member";
}

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Rename, avatar, and adding people — the everyday housekeeping. */
export function canManageGroup(actor: MemberRole | null): boolean {
  return actor === "owner" || actor === "admin";
}

/** Handing out and taking back the admin tier. The owner's alone. */
export function canManageRoles(actor: MemberRole | null): boolean {
  return actor === "owner";
}

/**
 * May `actor` remove `target`?
 *
 * Self-removal is false on purpose — that is `leaveGroup`, which is a different
 * operation with a different system message ("left" rather than "was removed")
 * and, for an owner, a succession to arrange.
 */
export function canRemoveMember(
  actor: MemberRole | null,
  target: MemberRole,
  options: { samePerson: boolean },
): boolean {
  if (options.samePerson) return false;
  if (!canManageGroup(actor)) return false;
  if (target === "owner") return false;
  if (target === "admin") return actor === "owner";
  return true;
}

/**
 * Who inherits the group when the owner leaves.
 *
 * The longest-standing admin, or failing that the longest-standing member. Time
 * served is the only tiebreak available that is not arbitrary, and it picks the
 * person most likely to still be around.
 *
 * Null means there is nobody left — the owner was the last member — and the
 * caller deletes the conversation rather than leaving an ownerless husk with a
 * unique index that nothing can ever satisfy again.
 *
 * `joinedAt` is compared as a string. ISO-8601 UTC timestamps sort
 * lexicographically in chronological order, which is why the query hands them
 * over untouched instead of parsing a hundred Dates to sort five rows.
 */
export function successorTo(
  leavingUserId: string,
  members: readonly { userId: string; role: MemberRole; joinedAt: string }[],
): string | null {
  const candidates = members
    .filter((m) => m.userId !== leavingUserId)
    .sort((a, b) => {
      // Admins first, then by seniority.
      const rank = (r: MemberRole) => (r === "admin" ? 0 : 1);
      const byRank = rank(a.role) - rank(b.role);
      return byRank !== 0 ? byRank : a.joinedAt.localeCompare(b.joinedAt);
    });

  return candidates[0]?.userId ?? null;
}

// ---------- names ----------

/** What a group's name may be. Matches the CHECK-free `title` column's practical
 *  limit and the composer's counter. */
export const GROUP_NAME_MAX_LENGTH = 120;

/**
 * Cleans a submitted group name, or says why it will not do.
 *
 * Collapses internal whitespace, because a name padded out with spaces to push
 * itself up a sorted list is a thing people do, and because "QA   team" and
 * "QA team" being two different groups is a bug report waiting to happen.
 */
export function normalizeGroupName(input: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(input ?? "").replace(/\s+/g, " ").trim();

  if (!name) return { ok: false, error: "Give the group a name." };
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    return { ok: false, error: `That name is ${name.length} characters. The limit is ${GROUP_NAME_MAX_LENGTH}.` };
  }
  return { ok: true, name };
}

// ---------- system messages ----------

export type SystemEvent =
  | "group.created"
  | "group.renamed"
  | "group.avatar"
  | "member.added"
  | "member.removed"
  | "member.left"
  | "member.role";

/**
 * The finished sentence a system message stores in `body`.
 *
 * Baked at write time with the names as they are NOW, deliberately — see the
 * note in migration 0004. Resolving names at read time would make an old line
 * rewrite itself when somebody is renamed, and turn into "Former member added
 * Former member" once a login is deleted. A log that changes is not a log.
 *
 * Written in the past tense and the third person because that is how it will
 * read to everybody except the one person who did it, which is nearly everybody.
 */
export function systemMessageBody(
  event: SystemEvent,
  actorName: string,
  detail?: { targetName?: string; groupName?: string; role?: MemberRole },
): string {
  const target = detail?.targetName ?? "someone";

  switch (event) {
    case "group.created":
      return `${actorName} created the group`;
    case "group.renamed":
      return `${actorName} changed the group name to "${detail?.groupName ?? "Group"}"`;
    case "group.avatar":
      return `${actorName} changed the group photo`;
    case "member.added":
      return `${actorName} added ${target}`;
    case "member.removed":
      return `${actorName} removed ${target}`;
    case "member.left":
      // No actor/target distinction to draw — they are the same person, and
      // "Jamie removed Jamie" reads like something went wrong.
      return `${actorName} left the group`;
    case "member.role":
      return detail?.role === "admin"
        ? `${actorName} made ${target} an admin`
        : `${actorName} removed ${target} as an admin`;
  }
}
