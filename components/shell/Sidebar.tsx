"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { BADGE_TONES, GROUP_LABELS, NAV, type NavCounts, type NavGroup, type NavItem } from "@/lib/shared/nav";
import { roleCan } from "@/lib/shared/roles";
import type { EnvStatus, RoleId } from "@/lib/types";

/**
 * Sidebar navigation and the per-account list.
 *
 * A client component only because the active link depends on the current path.
 * Everything it renders is passed in from the server layout — it does no fetching
 * and holds no state, so it re-renders on navigation and nothing else.
 */

export interface AccountRollup {
  id: string;
  displayName: string;
  free: number;
  total: number;
  worst: EnvStatus;
}

function Badge({ item, counts }: { item: NavItem; counts: NavCounts }) {
  if (!item.badge) return null;
  const count = counts[item.badge];
  if (!count) return null;

  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${BADGE_TONES[item.tone ?? "plain"]}`}>
      {count}
    </span>
  );
}

function NavLink({ item, counts, active }: { item: NavItem; counts: NavCounts; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        active
          ? "bg-brand-soft font-semibold text-brand-fg"
          : "font-medium text-muted hover:bg-subtle hover:text-ink"
      }`}
    >
      <Icon name={item.icon} className="h-4.5 w-4.5 shrink-0" />
      <span className="flex-1">{item.label}</span>
      <Badge item={item} counts={counts} />
    </Link>
  );
}

export function Sidebar({
  role,
  counts,
  accounts,
}: {
  role: RoleId;
  counts: NavCounts;
  accounts: AccountRollup[];
}) {
  const pathname = usePathname();
  const visible = NAV.filter((item) => !item.requires || roleCan(role, item.requires));

  const groups: NavGroup[] = ["overview", "activity", "settings"];

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-canvas">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
          <Icon name="servers" className="h-4.5 w-4.5" />
        </span>
        <span className="text-[17px] font-bold tracking-tight">Servers</span>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        {groups.map((group) => {
          const items = visible.filter((n) => n.group === group);
          // A group whose every entry is hidden by role hides its heading too,
          // rather than leaving a label over nothing.
          if (!items.length) return null;

          return (
            <div key={group} className="mt-5 first:mt-0">
              <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
                {GROUP_LABELS[group]}
              </p>
              <nav className="space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    counts={counts}
                    // startsWith so a detail route keeps its parent highlighted,
                    // but guarded so /health never lights up /health-something.
                    active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
                  />
                ))}
              </nav>
            </div>
          );
        })}

        <div className="mt-6">
          <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">Accounts</p>
          {accounts.length ? (
            <div className="space-y-0.5">
              {accounts.map((account) => (
                <Link
                  key={account.id}
                  href={`/environments?account=${encodeURIComponent(account.id)}`}
                  className="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-subtle"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      account.worst === "issue" ? "bg-bad" : account.free ? "bg-ok" : "bg-warn"
                    }`}
                  />
                  <span className="flex-1 truncate text-sm font-medium text-ink-2">{account.displayName}</span>
                  <span className="text-[11px] font-semibold text-faint">
                    {account.free}/{account.total}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="px-3 py-2 text-xs text-faint">No accounts yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
