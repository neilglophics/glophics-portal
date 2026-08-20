/**
 * "Is this claim mine?" — ported from State.signedInIdentityValues and
 * State.claimMatchesFilterUser in the legacy public/js/state.js.
 *
 * This is where the app's two identity spaces meet, and it is fiddly for a real
 * reason. A claim records **directory person** ids, because that is who can be
 * assigned work. The signed-in user is an **auth account**, which may or may not
 * point at a directory person. So a match is attempted several ways:
 *
 *   - the account's linked directory id
 *   - any Jira label that directory person answers to
 *   - the account's own username / display name
 *   - a raw Jira assignee label the sync could not resolve to anybody
 *
 * That last one matters: a ticket assigned to a label no directory person claims
 * would otherwise be invisible to its actual owner, which is exactly the failure
 * the Users page's coverage notice exists to warn about.
 */

import type { AuthUser, Claim, DirectoryUser } from "@/lib/types";

const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase();

/** Every string that could plausibly identify this person on a claim. */
export function identityValues(user: AuthUser | null, directory: DirectoryUser[]): Set<string> {
  const values = new Set<string>();
  if (!user) return values;

  if (user.directoryUserId) values.add(norm(user.directoryUserId));
  values.add(norm(user.username));
  values.add(norm(user.displayName));
  for (const name of user.jiraNames) values.add(norm(name));

  // The linked person's own display name, which is what an unresolved raw
  // assignee label most often looks like.
  const person = directory.find((d) => d.id === user.directoryUserId);
  if (person) {
    values.add(norm(person.name));
    for (const name of person.jiraNames) values.add(norm(name));
  }

  values.delete("");
  return values;
}

export function claimIsMine(claim: Claim, values: Set<string>, directory: DirectoryUser[]): boolean {
  if (!values.size) return false;

  // The cheap, reliable path: the claim names my directory id outright.
  if (claim.userIds.some((id) => values.has(norm(id)))) return true;

  // Then by the names those ids resolve to, and by labels nobody resolved.
  const names = claim.userIds
    .map((id) => directory.find((d) => d.id === id)?.name ?? id)
    .concat(claim.rawAssignees);

  return names.some((name) => values.has(norm(name)));
}

export function myClaims(claims: Claim[], user: AuthUser | null, directory: DirectoryUser[]): Claim[] {
  const values = identityValues(user, directory);
  if (!values.size) return [];
  return claims.filter((claim) => claimIsMine(claim, values, directory));
}
