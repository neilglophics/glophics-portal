"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { agoText } from "@/lib/shared/format";
import { ConnectionDot } from "./ConnectionDot";
import { ThemeSwitcher } from "./ThemeSwitcher";

/**
 * Search, connection status, and appearance controls.
 *
 * The two indicators are deliberately separate. "Live" is whether *other
 * people's* changes reach this tab; "Synced Nm ago" is how fresh the Jira data
 * is. One can be fine while the other is not, and a single combined light would
 * hide that.
 */
export function Topbar({
  jiraEnabled,
  lastSyncAt,
}: {
  jiraEnabled: boolean;
  lastSyncAt: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(params.get("q") ?? "");
  const searchRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key !== "/" || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      searchRef.current?.focus();
    }

    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, []);

  const syncLabel = !jiraEnabled
    ? "Jira off"
    : lastSyncAt
      ? `Synced ${agoText(lastSyncAt)} ago`
      : "Not synced yet";

  return (
    <header className="relative z-30 flex h-[72px] shrink-0 items-center gap-3 border-b border-line bg-surface/95 px-4 shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur-xl sm:px-6">
      <label className="group relative min-w-0 flex-1 sm:max-w-xl">
        <span className="sr-only">Search environments, tickets, or people</span>
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint transition-colors group-focus-within:text-brand-fg">
          <Icon name="search" className="h-4.5 w-4.5" />
        </span>
        <input
          ref={searchRef}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search environments, tickets, people…"
          className="h-11 w-full rounded-2xl bg-subtle pl-10 pr-11 text-sm font-medium text-ink-2 ring-1 ring-transparent transition placeholder:font-normal placeholder:text-faint focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {term ? (
          <button
            type="button"
            onClick={() => setTerm("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-faint transition hover:bg-subtle-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md bg-surface px-1.5 py-0.5 font-sans text-[10px] font-bold text-faint ring-1 ring-line-2 xl:block">
            /
          </kbd>
        )}
      </label>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="hidden items-center gap-2 lg:flex">
          <ConnectionDot />
          <div
            title={jiraEnabled ? syncLabel : "Jira integration is off"}
            className="flex h-9 max-w-[170px] items-center gap-2 rounded-xl bg-subtle px-3 text-xs font-semibold text-muted ring-1 ring-line-soft"
          >
            <Icon name="refresh" className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="truncate">{syncLabel}</span>
          </div>
        </div>
        <ThemeSwitcher />
      </div>
    </header>
  );
}
