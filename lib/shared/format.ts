/**
 * Pure formatting helpers. Ported from the legacy public/js/format.js.
 *
 * What is deliberately gone: `escapeHtml`. The old code composed HTML strings,
 * so every interpolation had to be escaped by hand. React escapes text children
 * by default, so the helper is not just unnecessary — keeping it would invite
 * `dangerouslySetInnerHTML`, which is the one way to reintroduce the problem.
 *
 * If rich text is ever wanted in chat, that is a sanitiser decision (see
 * docs/04-MIGRATION-PLAN.md Phase 9), not a reason to bring this back.
 */

import type { EnvStatus } from "@/lib/types";

export const STATUS_LABEL: Record<EnvStatus, string> = {
  free: "Free",
  partial: "Partly free",
  inuse: "In use",
  issue: "Server down",
};

export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatClock(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type RemainingLevel = "expired" | "warning" | "ok";

/** "Ends in 2h 15m" / "Expired", plus how alarmed to look about it. */
export function remaining(endIso: string, now = Date.now()): { text: string; level: RemainingLevel } {
  const diffMs = new Date(endIso).getTime() - now;
  if (diffMs <= 0) return { text: "Expired", level: "expired" };

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;

  const text =
    days > 0 ? `Ends in ${days}d ${hours}h` : hours > 0 ? `Ends in ${hours}h ${mins}m` : `Ends in ${mins}m`;

  return { text, level: diffMs < 3600000 ? "warning" : "ok" };
}

/** Compact "20m" / "3h" / "2d", for "synced X ago". */
export function agoText(iso: string, now = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 0) return "just now";

  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function repoUrlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}
