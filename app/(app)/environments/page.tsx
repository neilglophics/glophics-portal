import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { ButtonLink } from "@/components/ui/Button";
import { Dash, StatusChip } from "@/components/ui/Chips";
import { Page, PageHead } from "@/components/ui/Layout";
import { RepoStrip } from "@/components/ui/RepoStrip";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard } from "@/lib/db/queries/board";
import { myClaims } from "@/lib/shared/mine";
import { ENV_STATE } from "@/lib/shared/tokens";
import {
  envRows,
  filterEnvRows,
  isUrgent,
  leftText,
  minutesLeft,
  progress,
  statusCounts,
  type EnvRow,
} from "@/lib/shared/view-model";
import type { EnvStatus } from "@/lib/types";

/**
 * Every environment, free or held.
 *
 * Filters live in the URL rather than in memory, which the legacy version could
 * not do — so a filtered view is now shareable, survives a reload, and the back
 * button works. Each chip is a plain link, so the whole page stays server
 * rendered with no client JavaScript.
 */
export const metadata = { title: "Environments · Glophics Portal" };

type Search = { status?: string; account?: string; q?: string; mine?: string };

function href(base: Search, patch: Search): string {
  const params = new URLSearchParams();
  const merged = { ...base, ...patch };

  for (const [key, value] of Object.entries(merged)) {
    // "all" and empty are the default, so they are omitted rather than written —
    // a clean URL for the unfiltered view.
    if (value && value !== "all") params.set(key, value);
  }
  const query = params.toString();
  return query ? `/environments?${query}` : "/environments";
}

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle-2">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function StatusFilter({
  search,
  value,
  label,
  count,
}: {
  search: Search;
  value: string;
  label: string;
  count: number;
}) {
  const active = (search.status ?? "all") === value;
  return (
    <Link
      href={href(search, { status: value })}
      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition ${
        active ? "bg-accent text-on-accent" : "bg-surface text-muted ring-1 ring-line-2 hover:text-ink"
      }`}
    >
      {value !== "all" ? (
        <span className={`h-1.5 w-1.5 rounded-full ${ENV_STATE[value as EnvStatus].dot}`} />
      ) : null}
      {label} {count}
    </Link>
  );
}

function EnvironmentRow({ row }: { row: EnvRow }) {
  const token = ENV_STATE[row.state];
  const minutes = row.soonest ? minutesLeft(row.soonest) : null;

  return (
    <Tr>
      <Td>
        <Link href={`/environments/${encodeURIComponent(row.id)}`} className="group flex items-center gap-3">
          <span className={`h-7 w-1 shrink-0 rounded-full ${token.dot}`} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold group-hover:text-brand-fg group-hover:underline">
              {row.name}
            </span>
            <span className="block truncate text-[11px] text-faint">{row.accountName}</span>
          </span>
        </Link>
      </Td>

      <Td>
        <RepoStrip env={row.env} claims={row.claims} />
      </Td>

      <Td>
        <StatusChip status={row.state} />
      </Td>

      <Td>{row.people.length ? <AvatarStack people={row.people} /> : <Dash />}</Td>

      <Td>
        {row.ticketIds.length ? (
          <>
            <span className="whitespace-nowrap text-xs font-semibold text-brand-fg">{row.ticketIds[0]}</span>
            {row.ticketIds.length > 1 ? (
              <span className="ml-1 text-[11px] text-faint">+{row.ticketIds.length - 1}</span>
            ) : null}
          </>
        ) : (
          <Dash />
        )}
      </Td>

      <Td>
        {row.soonest ? (
          <>
            <p className={`text-sm ${isUrgent(minutes) ? "font-semibold text-warn" : "text-body"}`}>
              {leftText(minutes)}
            </p>
            <div className="mt-1.5 w-24">
              <Bar pct={progress(row.soonest)} className={token.bar} />
            </div>
          </>
        ) : row.claims.length ? (
          <span className="text-xs text-faint">No end time</span>
        ) : (
          <span className="text-sm font-medium text-ok">Ready to book</span>
        )}
      </Td>

      <Td className="text-right">
        <ButtonLink
          href={`/environments/${encodeURIComponent(row.id)}`}
          size="sm"
          variant={row.freeRepos.length ? "dark" : "quiet"}
          className="whitespace-nowrap"
        >
          {row.freeRepos.length ? "Assign" : "Open"}
        </ButtonLink>
      </Td>
    </Tr>
  );
}

export default async function EnvironmentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [board, user] = await Promise.all([getBoard(), currentUserOrNull()]);
  const { accounts, environments, claims, directory } = board;

  const all = envRows(environments, accounts, claims, directory);
  const counts = statusCounts(all);

  const mineIds = new Set(myClaims(claims, user, directory).map((c) => c.id));
  const showMine = search.mine === "1";

  const rows = filterEnvRows(
    all,
    { status: search.status, account: search.account, q: search.q, mine: showMine },
    mineIds,
  );

  const filtered = rows.length !== all.length;
  const account = accounts.find((a) => a.id === search.account);

  return (
    <Page>
      <PageHead
        title="Environments"
        sub={
          <>
            {all.length} environment{all.length === 1 ? "" : "s"} across {accounts.length} account
            {accounts.length === 1 ? "" : "s"}
            {account ? ` · filtered to ${account.displayName}` : ""}
          </>
        }
        actions={
          <ButtonLink href="/settings" variant="dark">
            Add environment
          </ButtonLink>
        }
      />

      <div className="flex flex-wrap items-center gap-2 pb-5">
        <StatusFilter search={search} value="all" label="All" count={all.length} />
        {(Object.keys(counts) as EnvStatus[]).map((key) => (
          <StatusFilter
            key={key}
            search={search}
            value={key}
            label={ENV_STATE[key].label}
            count={counts[key]}
          />
        ))}

        {/* Disabled rather than hidden when there is nothing to match on, so the
            control does not appear and disappear between users. */}
        {mineIds.size || showMine ? (
          <Link
            href={href(search, { mine: showMine ? "" : "1" })}
            className={`rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition ${
              showMine ? "bg-accent text-on-accent" : "bg-surface text-muted ring-1 ring-line-2 hover:text-ink"
            }`}
          >
            My servers
          </Link>
        ) : (
          <span
            title="Nothing on the board is assigned to you"
            className="cursor-not-allowed rounded-full bg-subtle-2 px-3.5 py-1.5 text-[11px] font-semibold text-faintest"
          >
            My servers
          </span>
        )}

        {filtered || search.q ? (
          <Link href="/environments" className="ml-1 text-[11px] font-semibold text-brand-fg hover:underline">
            Clear filters
          </Link>
        ) : null}
      </div>

      <Table
        isEmpty={!rows.length}
        empty={
          filtered || search.q
            ? "No environment matches these filters."
            : "No environments configured yet — add one in Settings."
        }
        head={
          <>
            <Th>Environment</Th>
            <Th>Repositories</Th>
            <Th>Status</Th>
            <Th>Assigned to</Th>
            <Th>Ticket</Th>
            <Th>Booked until</Th>
            <Th className="text-right" />
          </>
        }
      >
        {rows.map((row) => (
          <EnvironmentRow key={row.id} row={row} />
        ))}
      </Table>
    </Page>
  );
}
