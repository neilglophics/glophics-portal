import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { JiraChip } from "@/components/ui/Chips";
import { Icon } from "@/components/ui/Icon";
import { Empty, Page, StatTile } from "@/components/ui/Layout";
import { RepoStrip } from "@/components/ui/RepoStrip";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { getBoard } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { boardSummary } from "@/lib/shared/occupancy";
import { ENV_STATE, TONE, shortRepo } from "@/lib/shared/tokens";
import {
  claimRows,
  envRows,
  isUrgent,
  leftText,
  minutesLeft,
  nullsLast,
  progress,
  type EnvRow,
} from "@/lib/shared/view-model";

/** Overview of the pool: what's free, what's held, and what frees up next. */
export const metadata = { title: "Dashboard · Glophics Portal" };

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

export default async function DashboardPage() {
  const [{ accounts, environments, claims, directory }, avatars] = await Promise.all([
    getBoard(),
    avatarVersions(),
  ]);

  const summary = boardSummary(environments, claims);
  const rows = envRows(environments, accounts, claims, directory, avatars);

  // The three closest to freeing up, of whatever is not free.
  const held = rows
    .filter((r) => r.state !== "free")
    .sort((a, b) => nullsLast(minutesLeft(a.soonest ?? {})) - nullsLast(minutesLeft(b.soonest ?? {})))
    .slice(0, 3);

  const tickets = claimRows(environments, accounts, claims, directory, avatars);
  const topTickets = tickets.slice(0, 5);

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

      <section className="mt-7">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
          <div>
            <h2 className="text-[17px] font-bold tracking-tight">Active tickets</h2>
            <p className="mt-0.5 text-xs text-faint">
              {topTickets.length < tickets.length
                ? `The ${topTickets.length} freeing up first, of ${tickets.length} holding a repository`
                : `${tickets.length} ticket${tickets.length === 1 ? " is" : "s are"} holding a repository`}
            </p>
          </div>
          <Link href="/tickets" className="text-xs font-semibold text-brand-fg hover:underline">
            See all
          </Link>
        </div>

        <Table
          isEmpty={!topTickets.length}
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
          {topTickets.map((row) => (
            <Tr key={`${row.claim.id}-${row.serverId}`}>
              <Td>
                <AvatarStack people={row.people} />
              </Td>
              <Td>
                <p className="text-sm font-semibold">{row.env}</p>
                <p className="text-[11px] text-faint">
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
                <span className="text-sm text-body">{row.claim.summary || row.claim.note || "—"}</span>
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
      </section>
    </Page>
  );
}
