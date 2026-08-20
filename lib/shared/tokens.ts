/**
 * Every colour, label and icon the UI uses. Ported from public/js/ui/tokens.js.
 *
 * Components never hardcode a class string — they ask for a token — so a palette
 * change happens here and nowhere else. Values are Tailwind utility strings
 * referring to the semantic variables defined in app/globals.css.
 */

import type { EnvStatus, RepoHealth, RoleId } from "@/lib/types";

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
export const HEALTH: Record<RepoHealth, { label: string; chip: string; dot: string }> = {
  online: { label: "Online", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  offline: { label: "Offline", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  checking: { label: "Checking", chip: "bg-subtle-2 text-muted", dot: "bg-faint" },
  unconfigured: { label: "No URL set", chip: "bg-subtle-2 text-muted", dot: "bg-faintest" },
};

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
