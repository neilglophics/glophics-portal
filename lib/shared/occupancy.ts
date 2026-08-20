/**
 * Occupancy — derived, never stored.
 *
 * Ported from State.getDisplayStatus() in the legacy public/js/state.js. This is
 * the authoritative implementation; the `server_occupancy` Postgres view in
 * docs/02-DATA-MODEL.md mirrors it as a bulk optimisation and must be kept in
 * step with it, not the other way round.
 *
 * The rule, in order:
 *   1. Any offline repo  → "issue". "Needs attention" matters more than whether
 *      the environment is booked, so this outranks everything else.
 *   2. No repo claimed   → "free"
 *   3. Every repo claimed → "inuse"
 *   4. Anything between  → "partial" ("partly free")
 */

import type { Claim, EnvStatus, Environment } from "@/lib/types";

export function claimedRepoNames(claims: Claim[], serverId: string): Set<string> {
  const claimed = new Set<string>();
  for (const claim of claims) {
    if (claim.serverId !== serverId) continue;
    for (const repo of claim.repos) claimed.add(repo);
  }
  return claimed;
}

export function displayStatus(env: Environment, claims: Claim[]): EnvStatus {
  if (env.repos.some((r) => r.health === "offline")) return "issue";

  const claimed = claimedRepoNames(claims, env.id);
  if (claimed.size === 0) return "free";
  return env.repos.every((r) => claimed.has(r.repoName)) ? "inuse" : "partial";
}

/** Every claim currently holding this specific repo. More than one is legal —
 *  the legacy UI rendered that as "Shared". */
export function repoClaims(claims: Claim[], serverId: string, repoName: string): Claim[] {
  return claims.filter((c) => c.serverId === serverId && c.repos.includes(repoName));
}

export function isRepoHeld(claims: Claim[], serverId: string, repoName: string): boolean {
  return claims.some((c) => c.serverId === serverId && c.repos.includes(repoName));
}

export interface BoardSummary {
  total: number;
  free: number;
  partial: number;
  inuse: number;
  needsAttention: number;
  claimsCount: number;
  peopleCount: number;
  freeingSoon: number;
  reposHeld: number;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** The dashboard tiles and the sidebar badges. Ported from State.getSummary(). */
export function boardSummary(environments: Environment[], claims: Claim[], now = Date.now()): BoardSummary {
  let free = 0;
  let partial = 0;
  let needsAttention = 0;
  let freeingSoon = 0;
  let reposHeld = 0;

  const people = new Set<string>();
  const countedClaims = new Set<string>();

  for (const env of environments) {
    if (env.repos.some((r) => r.health === "offline")) needsAttention += 1;

    const claimed = claimedRepoNames(claims, env.id);
    reposHeld += claimed.size;

    if (claimed.size === 0) free += 1;
    else if (!env.repos.every((r) => claimed.has(r.repoName))) partial += 1;

    for (const claim of claims) {
      if (claim.serverId !== env.id) continue;
      for (const id of claim.userIds) people.add(id);
      if (!countedClaims.has(claim.id)) countedClaims.add(claim.id);
      if (claim.endTime) {
        const msLeft = new Date(claim.endTime).getTime() - now;
        if (msLeft > 0 && msLeft < TWO_HOURS_MS) freeingSoon += 1;
      }
    }
  }

  return {
    total: environments.length,
    free,
    partial,
    // Matches the legacy definition: anything not fully free counts as in use.
    inuse: environments.length - free,
    needsAttention,
    claimsCount: countedClaims.size,
    peopleCount: people.size,
    freeingSoon,
    reposHeld,
  };
}
