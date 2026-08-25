/**
 * Every colour, label and icon the UI uses. Ported from public/js/ui/tokens.js.
 *
 * Components never hardcode a class string — they ask for a token — so a palette
 * change happens here and nowhere else. Values are Tailwind utility strings
 * referring to the semantic variables defined in app/globals.css.
 */

import type { Availability, EnvStatus, RepoHealth, RoleId, ServerRepo } from "@/lib/types";

export interface StateToken {
  label: string;
  chip: string;
  dot: string;
  bar: string;
  tone: Tone;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "alt" | "brand" | "neutral";

/** Derived environment status, from lib/shared/occupancy.ts displayStatus(). */
export const ENV_STATE: Record<EnvStatus, StateToken> = {
  free: { label: "Free", chip: "bg-ok-soft text-ok", dot: "bg-ok", bar: "bg-ok", tone: "ok" },
  partial: {
    label: "Partly free",
    chip: "bg-brand-soft text-brand-fg",
    dot: "bg-brand-500",
    bar: "bg-brand-500",
    tone: "brand",
  },
  inuse: { label: "In use", chip: "bg-warn-soft text-warn", dot: "bg-warn", bar: "bg-warn", tone: "warn" },
  issue: { label: "Server down", chip: "bg-bad-soft text-bad", dot: "bg-bad", bar: "bg-bad", tone: "bad" },
};

/** Per-repo reachability. */
/**
 * How loaded somebody is, on the team roster.
 *
 * Overloaded is `warn`, not `bad`, deliberately: on this board red means
 * *broken* — an offline repository, the one state that outranks everything in
 * the derived status. Somebody holding four environments is a scheduling
 * problem, not a fault, and painting it the same colour as a dead server would
 * make both read as noise.
 */
export const AVAILABILITY: Record<Availability, { label: string; chip: string; dot: string; tone: Tone }> = {
  free: { label: "Free", chip: "bg-ok-soft text-ok", dot: "bg-ok", tone: "ok" },
  assigned: { label: "Working", chip: "bg-info-soft text-info", dot: "bg-info", tone: "info" },
  busy: { label: "Holding", chip: "bg-brand-soft text-brand-fg", dot: "bg-brand-500", tone: "brand" },
  overloaded: { label: "Overloaded", chip: "bg-warn-soft text-warn", dot: "bg-warn", tone: "warn" },
};

export const HEALTH: Record<RepoHealth, { label: string; chip: string; dot: string }> = {
  online: { label: "Online", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  offline: { label: "Offline", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  checking: { label: "Checking", chip: "bg-subtle-2 text-muted", dot: "bg-faint" },
  unconfigured: { label: "No URL set", chip: "bg-subtle-2 text-muted", dot: "bg-faintest" },
};

/**
 * The state a repository badge reports on a ticket row: is this repository
 * reachable, and is anyone on it.
 *
 * Same vocabulary and the same precedence as the SF/API/ADM strip on the board
 * (see components/ui/RepoStrip.tsx) — offline outranks occupancy, per invariant
 * 1 — but in the soft tones the tables use, so a row of badges sits beside a
 * status chip without shouting over it.
 *
 * `unknown` is not a health value: it is a repository we cannot resolve, either
 * because the ticket matched no environment or because that slot has no URL, so
 * nothing has ever been checked.
 */
export type RepoBadgeState = "offline" | "occupied" | "free" | "unknown";

export const REPO_BADGE: Record<RepoBadgeState, { word: string; chip: string; dot: string }> = {
  offline: { word: "offline", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  occupied: { word: "occupied", chip: "bg-warn-soft text-warn", dot: "bg-warn" },
  free: { word: "online, free", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  unknown: { word: "no URL configured", chip: "bg-subtle-2 text-muted", dot: "bg-faint" },
};

/**
 * Which of those a repository is in. The precedence is the board's, not a new
 * one:
 *
 * 1. **offline outranks everything** — invariant 1. A ticket holding a box that
 *    is down is the case people most need to see, and it must not read amber.
 * 2. **unknown** — no repository resolved, or the slot has no URL, so no check
 *    has ever run. Grey, because "we don't know" is not "free".
 * 3. **occupied** — some claim holds it. Ask lib/shared/occupancy.ts rather
 *    than assuming from the row: a board row that merely *names* a repository
 *    should still tell the truth about who is on it.
 * 4. **free** — reachable, and nobody on it.
 *
 * `repo` is undefined when the ticket matched no environment, which is the
 * Not-tracked case — we do not know which box it meant, so we do not guess.
 */
export function repoBadgeState(repo: ServerRepo | undefined, held: boolean): RepoBadgeState {
  if (!repo) return "unknown";
  if (repo.health === "offline") return "offline";
  if (!repo.url || repo.health === "unconfigured") return "unknown";
  return held ? "occupied" : "free";
}

/**
 * Jira workflow statuses arrive in Jira's own casing ("QA Testing (Stg)"), so
 * matching is case-insensitive and anything unknown gets a neutral chip.
 */
const JIRA_CHIPS: Record<string, string> = {
  "qa testing (dev)": "bg-info-soft text-info",
  "qa testing (stg)": "bg-alt-soft text-alt",
  "qa testing (live)": "bg-ok-soft text-ok",
  "final checking": "bg-ok-soft text-ok",
  done: "bg-ok-soft text-ok",
  "qa failed": "bg-bad-soft text-bad",
};

export function jiraChip(status: string | null | undefined): string {
  return JIRA_CHIPS[String(status ?? "").trim().toLowerCase()] ?? "bg-subtle-2 text-muted";
}

/** Access roles. The tone ranks with the reach, so a super admin never reads
 *  the same as a viewer at a glance. */
const ROLE_CHIPS: Record<RoleId, string> = {
  superadmin: "bg-alt-soft text-alt",
  admin: "bg-brand-soft text-brand-fg",
  member: "bg-info-soft text-info",
  viewer: "bg-neutral-soft text-neutral",
};

export function roleChip(roleId: string | null | undefined): string {
  return ROLE_CHIPS[roleId as RoleId] ?? "bg-subtle-2 text-muted";
}

/**
 * Avatar colour is derived from the id so a person keeps the same colour
 * everywhere, across reloads, without storing anything.
 */
const AVATAR_TONES = [
  "bg-alt-soft text-alt",
  "bg-info-soft text-info",
  "bg-ok-soft text-ok",
  "bg-warn-soft text-warn",
  "bg-bad-soft text-bad",
  "bg-brand-soft text-brand-fg",
];

export function avatarTone(key: string): string {
  const str = String(key);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

/** Repo chips are too narrow for full names. Known repos get the label the team
 *  already uses; anything custom falls back to its first three letters. */
const REPO_SHORT: Record<string, string> = { storefront: "SF", backend: "API", admin: "ADM" };

export function shortRepo(name: string): string {
  return REPO_SHORT[name] ?? String(name).slice(0, 3).toUpperCase();
}

/** Initials for an avatar, from names shaped like "[BE]_Sem". */
export function initials(name: string | null | undefined): string {
  const bare = String(name ?? "").replace(/^\[[^\]]*\]_?/, "").trim();
  const parts = bare.split(/[\s_.-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export const TONE: Record<Tone, { soft: string; fg: string; ring: string }> = {
  ok: { soft: "bg-ok-soft", fg: "text-ok", ring: "ring-ok-soft" },
  warn: { soft: "bg-warn-soft", fg: "text-warn", ring: "ring-warn-soft" },
  bad: { soft: "bg-bad-soft", fg: "text-bad", ring: "ring-bad-soft" },
  info: { soft: "bg-info-soft", fg: "text-info", ring: "ring-info-soft" },
  alt: { soft: "bg-alt-soft", fg: "text-alt", ring: "ring-alt-soft" },
  brand: { soft: "bg-brand-soft", fg: "text-brand-fg", ring: "ring-brand-soft" },
  neutral: { soft: "bg-neutral-soft", fg: "text-neutral", ring: "ring-neutral-soft" },
};

/**
 * The icon set. Geometry lives in components/ui/Icon.tsx as JSX so the original
 * circles and rounded rects survive verbatim — flattening them into single path
 * strings would have quietly dropped the corner radii. This module keeps only
 * the name union, so a typo is a compile error.
 */
export type IconName =
  | "grid" | "servers" | "pulse" | "clock" | "list" | "alert" | "users" | "gear"
  | "check" | "plug" | "refresh" | "search" | "bell" | "key" | "logout"
  | "external" | "note" | "copy" | "close" | "chevron" | "plus" | "chat";
