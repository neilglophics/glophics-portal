/**
 * The sidebar. Ported from NAV in the legacy public/js/ui/shell.js.
 *
 * Adding a page means adding one entry here and one file under app/(app)/. An
 * entry with `requires` only appears for a role that holds that capability —
 * hiding it is courtesy, and the route behind it is checked again on the server.
 */

import type { Capability, IconName } from "./nav-types";

export type NavGroup = "overview" | "activity" | "settings";
export type BadgeTone = "rose" | "amber" | "plain";

export interface NavItem {
  group: NavGroup;
  href: string;
  label: string;
  icon: IconName;
  requires?: Capability;
  /** Which counter from NavCounts to show, if any. */
  badge?: keyof NavCounts;
  tone?: BadgeTone;
}

export interface NavCounts {
  claims: number;
  myTickets: number;
  repoOffline: number;
  reposHeld: number;
  skipped: number;
  unreadChats: number;
}

export const NAV: readonly NavItem[] = [
  { group: "overview", href: "/dashboard", label: "Dashboard", icon: "grid" },
  { group: "overview", href: "/tickets", label: "Active tickets", icon: "list", badge: "claims" },
  { group: "overview", href: "/my-tickets", label: "My tickets", icon: "users", badge: "myTickets" },
  // Superadmin only. No badge: the shell renders on every page, and a count
  // here would mean the roster aggregate runs for every request of every
  // page — for a number nobody is waiting on.
  { group: "overview", href: "/team", label: "Team", icon: "users", requires: "oversee" },
  { group: "overview", href: "/environments", label: "Environments", icon: "servers" },
  { group: "overview", href: "/health", label: "Health", icon: "pulse", badge: "repoOffline", tone: "rose" },

  { group: "activity", href: "/in-use", label: "In use", icon: "clock", badge: "reposHeld" },
  { group: "activity", href: "/not-tracked", label: "Not tracked", icon: "alert", badge: "skipped", tone: "amber" },
  // Phase 9. The route is not built yet, so it is gated on `chat` and will
  // simply not render for anyone until the capability and the page both exist.
  { group: "activity", href: "/chat", label: "Chat", icon: "chat", requires: "chat", badge: "unreadChats" },

  { group: "settings", href: "/users", label: "Users", icon: "users", requires: "manage-users" },
  { group: "settings", href: "/settings", label: "Settings", icon: "gear", requires: "configure" },
] as const;

export const GROUP_LABELS: Record<NavGroup, string> = {
  overview: "Overview",
  activity: "Activity",
  settings: "Settings",
};

export const BADGE_TONES: Record<BadgeTone, string> = {
  rose: "bg-bad-soft text-bad",
  amber: "bg-warn-soft text-warn",
  plain: "bg-subtle-2 text-muted",
};
