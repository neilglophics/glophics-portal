import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { ButtonLink } from "@/components/ui/Button";
import { Dash, StatusChip } from "@/components/ui/Chips";
import { Page, PageHead } from "@/components/ui/Layout";
import { RepoStrip } from "@/components/ui/RepoStrip";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { myClaims } from "@/lib/shared/mine";
import { ENV_STATE } from "@/lib/shared/tokens";
import {
  envRows,
  filterEnvRows,
  isUrgent,
  leftText,
  minutesLeft,
  normalizeEnvView,
  progress,
  statusCounts,
  type EnvRow,
} from "@/lib/shared/view-model";
import type { Account, EnvStatus } from "@/lib/types";

/**
 * Every environment, free or held.
 *
 * Filters live in the URL rather than in memory, which the legacy version could
 * not do — so a filtered view is now shareable, survives a reload, and the back
 * button works. Each chip is a plain link, so the whole page stays server
 * rendered with no client JavaScript.
 */
export const metadata = { title: "Environments · Glophics Portal" };

type Search = { status?: string; account?: string; q?: string; mine?: string; view?: string };

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

function ViewToggle({ search, value, label }: { search: Search; value: "table" | "matrix"; label: string }) {
  const active = normalizeEnvView(search.view) === value;

  return (
    <Link
      href={href(search, { view: value })}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold transition ${
        active ? "bg-accent text-on-accent shadow-sm" : "text-muted ring-1 ring-line-2 hover:bg-subtle hover:text-ink"
      }`}
    >
      {value === "table" ? <span className="text-[12px]">▤</span> : <span className="text-[12px]">▦</span>}
      {label}
    </Link>
  );
}

function MatrixView({ rows, accounts }: { rows: EnvRow[]; accounts: Account[] }) {
  const repoOrder = ["storefront", "backend", "admin"];
  const repoNames = [...new Set(rows.flatMap((row) => row.repos.map((repo) => repo.repoName)))];
  const orderedRepos = [...repoOrder.filter((repo) => repoNames.includes(repo)), ...repoNames.filter((repo) => !repoOrder.includes(repo))];
  const groups = accounts.filter((account) => rows.some((row) => row.accountId === account.id));

  const repoLabel = (repo: string) => {
    const labels: Record<string, string> = { storefront: "Frontend", backend: "API", admin: "Admin" };
    return labels[repo] ?? repo;
  };

  return (
    <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full text-left">
          <thead>
            <tr className="border-b border-line text-[10px] font-bold tracking-[0.12em] text-faint">
              <Th>Account</Th>
              {orderedRepos.map((repo) => (
                <Th key={repo}>{repoLabel(repo)}</Th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {groups.map((account) => {
              const accountRows = rows.filter((row) => row.accountId === account.id);

              return (
                <Tr key={account.id}>
                  <Td>
                    <div className="min-w-[180px]">
                      <p className="text-sm font-bold">{account.displayName}</p>
                    </div>
                  </Td>

                  {orderedRepos.map((repo) => {
                    const cells = accountRows.flatMap((row) =>
                      row.claims
                        .filter((claim) => claim.repos.includes(repo))
                        .map((claim) => ({ claim, envName: row.name, people: row.people })),
                    );

                    return (
                      <Td key={`${account.id}-${repo}`} className="align-top">
                        {!cells.length ? (
                          <span className="text-xs font-medium text-ok">Free</span>
                        ) : (
                          <div className="space-y-2">
                            {cells.map(({ claim, envName, people }) => (
                              <div key={`${claim.id}-${repo}`} className="rounded-lg border border-line-soft bg-subtle-2 p-2">
                                <Link
                                  href={`/environments/${encodeURIComponent(claim.serverId)}`}
                                  className="text-xs font-bold text-brand-fg hover:underline"
                                >
                                  {claim.id}
                                </Link>
                                <div className="mt-1 flex items-center gap-2 min-w-0">
                                  {people.length ? <AvatarStack people={people} max={2} /> : null}
                                  {people.length ? (
                                    <span className="truncate text-[10px] text-faint" title={people.map((person) => person.name).join(", ")}>
                                      {people.slice(0, 2).map((person) => person.name).join(", ")}
                                      {people.length > 2 ? ` +${people.length - 2}` : ""}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 truncate text-[10px] text-faint" title={envName}>
                                  {envName}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </Td>
                    );
                  })}
                </Tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function EnvironmentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [board, user, avatars] = await Promise.all([
    getBoard(),
    currentUserOrNull(),
    avatarVersions(),
  ]);
  const { accounts, environments, claims, directory } = board;

  const all = envRows(environments, accounts, claims, directory, avatars);
  const counts = statusCounts(all);
  const view = normalizeEnvView(search.view);

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
        <div className="inline-flex items-center gap-2 rounded-2xl bg-surface p-1 shadow-sm ring-1 ring-line-2">
          <span className="px-2 text-[11px] font-semibold text-faint">View</span>
          <ViewToggle search={search} value="table" label="Table" />
          <ViewToggle search={search} value="matrix" label="Matrix" />
        </div>

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

      {view === "matrix" ? (
        <MatrixView rows={rows} accounts={accounts} />
      ) : (
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
      )}
    </Page>
  );
}
