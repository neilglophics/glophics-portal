import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { Chip, Dash, JiraChip } from "@/components/ui/Chips";
import { Icon } from "@/components/ui/Icon";
import { Empty, Page, StatTile } from "@/components/ui/Layout";
import { RepoStrip } from "@/components/ui/RepoStrip";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard, getJiraIssues } from "@/lib/db/queries/board";
import { boardSummary } from "@/lib/shared/occupancy";
import { jiraActivity } from "@/lib/shared/activity";
import { agoText } from "@/lib/shared/format";
import { ENV_STATE, TONE, shortRepo } from "@/lib/shared/tokens";
import {
  boardRows,
  claimRows,
  envRows,
  isUrgent,
  leftText,
  minutesLeft,
  nullsLast,
  progress,
  type EnvRow,
  type TicketRow,
} from "@/lib/shared/view-model";

/** Overview of the pool: what's free, what's held, and what frees up next. */
export const metadata = { title: "Dashboard · Glophics Portal" };

const PAGE_SIZE = 5;

type Search = { activePage?: string; updatesPage?: string };

/** Same "filters live in the URL" idiom as /environments — a Link, not a
 *  client component, so the page stays server rendered with no client JS. */
function pageHref(search: Search, patch: Partial<Search>): string {
  const params = new URLSearchParams();
  const merged = { ...search, ...patch };
  for (const [key, value] of Object.entries(merged)) {
    if (value && value !== "1") params.set(key, value);
  }
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

function paginate<T>(items: T[], pageParam: string | undefined) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const requested = Math.max(1, Math.floor(Number(pageParam)) || 1);
  const page = Math.min(requested, totalPages);
  const start = (page - 1) * PAGE_SIZE;
  return { items: items.slice(start, start + PAGE_SIZE), page, totalPages };
}

function Pager({
  page,
  totalPages,
  search,
  paramKey,
}: {
  page: number;
  totalPages: number;
  search: Search;
  paramKey: keyof Search;
}) {
  if (totalPages <= 1) return null;

  const navLink = (dir: "prev" | "next", targetPage: number, disabled: boolean) => (
    <Link
      href={pageHref(search, { [paramKey]: String(targetPage) })}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      className={`grid h-7 w-7 place-items-center rounded-full text-faint ring-1 ring-line-2 transition ${
        disabled
          ? "pointer-events-none opacity-40"
          : "hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft"
      }`}
    >
      <Icon name="chevron" className={`h-3 w-3 ${dir === "prev" ? "rotate-180" : ""}`} />
    </Link>
  );

  return (
    <div className="flex items-center justify-end gap-2 pt-3">
      {navLink("prev", page - 1, page <= 1)}
      <span className="text-[11px] font-semibold text-faint">
        Page {page} of {totalPages}
      </span>
      {navLink("next", page + 1, page >= totalPages)}
    </div>
  );
}

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle-2">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function HeldCard({ row }: { row: EnvRow }) {
  const token = ENV_STATE[row.state];
  const tone = TONE[token.tone];
  const minutes = row.soonest ? minutesLeft(row.soonest) : null;

  return (
    <article className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <div className={`flex h-24 flex-col justify-between p-3 ${tone.soft}`}>
        <div className="flex items-start justify-between">
          <span
            className={`rounded-full bg-surface/70 px-2.5 py-1 text-[10px] font-bold backdrop-blur ${tone.fg}`}
          >
            {token.label}
          </span>
        </div>
        <RepoStrip env={row.env} claims={row.claims} />
      </div>

      <div className="p-4">
        <span className="inline-block rounded-md bg-subtle-2 px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted">
          {row.accountName.toUpperCase()}
        </span>
        <h3 className="mt-2.5 text-sm font-bold">{row.name}</h3>

        <div className="mt-3">
          <Bar pct={row.soonest ? progress(row.soonest) : 0} className={token.bar} />
        </div>
        <p className={`mt-1.5 text-[11px] ${isUrgent(minutes) ? "font-medium text-warn" : "text-faint"}`}>
          {!row.soonest
            ? "No end time set"
            : minutes !== null && minutes <= 0
              ? "Booking expired"
              : `Frees in ${leftText(minutes)}`}
        </p>

        <div className="mt-3.5 flex items-center gap-2.5 border-t border-line-soft pt-3.5">
          {row.claims.length ? (
            <>
              <AvatarStack people={row.people} />
              <p className="ml-1 truncate text-[11px] text-faint">{row.ticketIds.join(", ")}</p>
            </>
          ) : (
            <p className="text-[11px] text-faint">
              {row.offline.length ? "Offline — no active claim" : "No active claim"}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/** One row of the Latest Jira updates panel — Ticket (+ activity badge and
 *  message), Assignee, Status, Branch, Repos. */
function JiraUpdateRow({
  row,
  activity,
}: {
  row: TicketRow;
  activity: ReturnType<typeof jiraActivity>;
}) {
  return (
    <Tr>
      <Td>
        <span className="inline-flex items-center gap-1.5">
          <span className="whitespace-nowrap text-xs font-bold text-brand-fg">{row.claim.id}</span>
          {activity ? <Chip className={activity.chipClassName}>{activity.badge}</Chip> : null}
        </span>
        {row.claim.jiraUpdatedAt ? (
          <p className="whitespace-nowrap text-[10px] text-faint">{agoText(row.claim.jiraUpdatedAt)} ago</p>
        ) : null}
        {activity ? (
          <p className="max-w-[11rem] truncate text-[10px] text-muted" title={activity.message}>
            {activity.message}
          </p>
        ) : null}
      </Td>
      <Td>
        <AvatarStack people={row.people} max={2} />
      </Td>
      <Td>
        <JiraChip status={row.claim.status} />
      </Td>
      <Td>
        <p
          className="max-w-[7rem] truncate text-xs font-medium text-body"
          title={row.claim.branch ?? row.env}
        >
          {row.claim.branch ?? row.env}
        </p>
      </Td>
      <Td>
        {row.claim.repos.length ? (
          <Chip className={row.holding ? "bg-warn-soft text-warn" : "bg-subtle-2 text-muted"}>
            {row.claim.repos.map(shortRepo).join(" ")}
          </Chip>
        ) : (
          <Dash />
        )}
      </Td>
    </Tr>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [{ accounts, environments, claims, directory }, issues, user] = await Promise.all([
    getBoard(),
    getJiraIssues(),
    currentUserOrNull(),
  ]);

  const summary = boardSummary(environments, claims);
  const rows = envRows(environments, accounts, claims, directory);

  // The three closest to freeing up, of whatever is not free.
  const held = rows
    .filter((r) => r.state !== "free")
    .sort((a, b) => nullsLast(minutesLeft(a.soonest ?? {})) - nullsLast(minutesLeft(b.soonest ?? {})))
    .slice(0, 3);

  const tickets = claimRows(environments, accounts, claims, directory);
  const active = paginate(tickets, search.activePage);

  // Every Jira-sourced ticket touched recently, holding a repository or not —
  // most recently updated first. Nothing here is a diff against a previous
  // sync (see lib/shared/activity.ts); it's just recency.
  const jiraUpdates = [...tickets, ...boardRows(issues, environments, accounts, directory)]
    .filter((r) => r.claim.source === "jira" && r.claim.jiraUpdatedAt)
    .sort((a, b) => new Date(b.claim.jiraUpdatedAt!).getTime() - new Date(a.claim.jiraUpdatedAt!).getTime());
  const updates = paginate(jiraUpdates, search.updatesPage);

  const repoOffline = environments.reduce(
    (n, env) => n + env.repos.filter((r) => r.health === "offline").length,
    0,
  );

  return (
    <Page>
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 px-8 py-7 text-white">
        <svg
          className="pointer-events-none absolute -right-6 top-1/2 h-56 w-56 -translate-y-1/2 text-white/15"
          viewBox="0 0 100 100"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M50 4c2 26 18 42 44 46-26 4-42 20-46 46-4-26-20-42-46-46 26-4 42-20 48-46z" />
        </svg>

        <p className="text-[11px] font-bold tracking-[0.16em] text-white/70">ENVIRONMENT POOL</p>
        <h1 className="mt-2 max-w-lg text-[27px] font-bold leading-tight tracking-tight">
          {summary.free === 0 ? (
            "Every environment is taken"
          ) : (
            <>
              {summary.free} environment{summary.free === 1 ? " is" : "s are"} free
              <br />
              and ready to book
            </>
          )}
        </h1>
        <p className="mt-2 max-w-md text-sm text-white/75">
          {summary.free === 0
            ? "Free one up, or wait for the next booking to end."
            : "Claim one before your ticket reaches QA testing."}
        </p>

        {/* text-on-accent is explicit: the section sets text-white, which would
            otherwise be inherited onto a button that goes light in dark mode. */}
        <Link
          href="/environments"
          className="mt-5 inline-flex items-center gap-2.5 rounded-full bg-accent py-2.5 pl-5 pr-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-2"
        >
          Browse environments
          <span className="grid h-6 w-6 place-items-center rounded-full bg-on-accent/15">
            <Icon name="chevron" className="h-3 w-3" />
          </span>
        </Link>
      </section>

      <section className="mt-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          tone="ok"
          label="Available now"
          value={summary.free}
          sub={`of ${summary.total} environments`}
          icon="check"
        />
        <StatTile
          tone="warn"
          label="In use"
          value={summary.inuse}
          sub={`${summary.claimsCount} active claim${summary.claimsCount === 1 ? "" : "s"}`}
          icon="clock"
        />
        <StatTile
          tone="bad"
          label="Needs attention"
          value={summary.needsAttention}
          sub={`${repoOffline} endpoint${repoOffline === 1 ? "" : "s"} offline`}
          icon="alert"
        />
        <StatTile
          tone="brand"
          label="Freeing up soon"
          value={summary.freeingSoon}
          sub="within 2 hours"
          icon="clock"
        />
      </section>

      <section className="mt-7">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-bold tracking-tight">Held right now</h2>
          <Link href="/in-use" className="text-xs font-semibold text-brand-fg hover:underline">
            See all
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {held.length ? (
            held.map((row) => <HeldCard key={row.id} row={row} />)
          ) : (
            <Empty message="Nothing is held — every environment is free." />
          )}
        </div>
      </section>

      <section className="mt-7 flex flex-col gap-5 xl:flex-row">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              <h2 className="text-[17px] font-bold tracking-tight">Active tickets</h2>
              <p className="mt-0.5 text-xs text-faint">
                {tickets.length} ticket{tickets.length === 1 ? " is" : "s are"} holding a repository, soonest
                to free first
              </p>
            </div>
            <Link href="/tickets" className="text-xs font-semibold text-brand-fg hover:underline">
              See all
            </Link>
          </div>

          <Table
            isEmpty={!active.items.length}
            empty="No ticket is holding a repository."
            head={
              <>
                <Th>Holders</Th>
                <Th>Environment</Th>
                <Th>Ticket</Th>
                <Th>Status</Th>
                <Th>Summary</Th>
                <Th className="text-right">Frees in</Th>
              </>
            }
          >
            {active.items.map((row) => (
              <Tr key={`${row.claim.id}-${row.serverId}`}>
                <Td>
                  <AvatarStack people={row.people} />
                </Td>
                <Td>
                  <p className="max-w-[10rem] truncate text-sm font-semibold" title={row.env}>
                    {row.env}
                  </p>
                  <p
                    className="max-w-[10rem] truncate text-[11px] text-faint"
                    title={`${row.accountName} · ${row.claim.repos.map(shortRepo).join(", ")}`}
                  >
                    {row.accountName} · {row.claim.repos.map(shortRepo).join(", ")}
                  </p>
                </Td>
                <Td>
                  <span className="text-xs font-semibold text-brand-fg">{row.claim.id}</span>
                </Td>
                <Td>
                  <JiraChip status={row.claim.status} />
                </Td>
                <Td>
                  <p
                    className="max-w-[260px] truncate text-sm text-body"
                    title={row.claim.summary || row.claim.note || "—"}
                  >
                    {row.claim.summary || row.claim.note || "—"}
                  </p>
                </Td>
                <Td className="text-right">
                  <span
                    className={`text-sm font-semibold ${isUrgent(row.minutesLeft) ? "text-warn" : "text-muted"}`}
                  >
                    {leftText(row.minutesLeft)}
                  </span>
                </Td>
              </Tr>
            ))}
          </Table>
          <Pager page={active.page} totalPages={active.totalPages} search={search} paramKey="activePage" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              <h2 className="text-[17px] font-bold tracking-tight">Latest Jira updates</h2>
              <p className="mt-0.5 text-xs text-faint">Most recently updated tickets, synced from Jira</p>
            </div>
            <Link href="/tickets" className="text-xs font-semibold text-brand-fg hover:underline">
              See all
            </Link>
          </div>

          <Table
            isEmpty={!updates.items.length}
            empty="Nothing from Jira yet — run a sync."
            minWidth=""
            head={
              <>
                <Th>Ticket</Th>
                <Th>Assignee</Th>
                <Th>Status</Th>
                <Th>Branch</Th>
                <Th>Repos</Th>
              </>
            }
          >
            {updates.items.map((row) => (
              <JiraUpdateRow
                key={`${row.claim.id}::${row.serverId ?? "none"}`}
                row={row}
                activity={jiraActivity(row, directory, user)}
              />
            ))}
          </Table>
          <Pager page={updates.page} totalPages={updates.totalPages} search={search} paramKey="updatesPage" />
        </div>
      </section>
    </Page>
  );
}
