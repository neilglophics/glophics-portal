"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { agoText } from "@/lib/shared/format";
import { AccountMenu } from "./AccountMenu";
import { ConnectionDot } from "./ConnectionDot";
import { ThemeSwitcher } from "./ThemeSwitcher";
import type { AuthUser } from "@/lib/types";

/**
 * Search, the live-connection dot, Jira freshness, appearance, and the account
 * menu.
 *
 * The two indicators are deliberately separate. "Live" is whether *other
 * people's* changes reach this tab; "Synced Nm ago" is how fresh the Jira data
 * is. One can be fine while the other is not, and a single combined light would
 * hide that.
 */
export function Topbar({
  user,
  jiraEnabled,
  lastSyncAt,
}: {
  user: AuthUser;
  jiraEnabled: boolean;
  lastSyncAt: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(params.get("q") ?? "");

  // Keep the field in step when navigation changes the query from elsewhere
  // (a cleared filter, a link with its own ?q=).
  useEffect(() => {
    setTerm(params.get("q") ?? "");
  }, [params]);

  // Debounced, and it navigates rather than holding filter state: the URL is
  // then shareable and survives a reload, which the legacy in-memory filter
  // could not do.
  useEffect(() => {
    const current = params.get("q") ?? "";
    if (term === current) return;

    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (term.trim()) next.set("q", term.trim());
      else next.delete("q");
      router.push(`/environments?${next.toString()}`);
    }, 250);

    return () => clearTimeout(timer);
  }, [term, params, router]);

  const syncLabel = !jiraEnabled
    ? "Jira off"
    : lastSyncAt
      ? `Synced ${agoText(lastSyncAt)} ago`
      : "Not synced yet";

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-3 sm:px-6">
      <label className="relative min-w-0 flex-1 sm:max-w-md">
        <span className="sr-only">Search environments</span>
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <Icon name="search" className="h-4 w-4" />
        </span>
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search environments, tickets, people…"
          className="w-full rounded-full bg-subtle py-2 pl-9 pr-3 text-sm text-ink-2 placeholder:text-faintest focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft"
        />
      </label>

      <ConnectionDot />

      <div
        title={jiraEnabled ? syncLabel : "Jira integration is off"}
        className="hidden max-w-[160px] shrink-0 items-center gap-2 text-xs font-medium text-faint lg:flex"
      >
        <Icon name="refresh" className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{syncLabel}</span>
      </div>

      <ThemeSwitcher />
      <AccountMenu user={user} />
    </header>
  );
}
