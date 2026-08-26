import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { JiraAutoSync } from "@/components/dashboard/JiraAutoSync";
import { Chip, Dash, JiraChip } from "@/components/ui/Chips";
import { Icon } from "@/components/ui/Icon";
import { ClaimRepoLinks, TicketLink } from "@/components/ui/JiraLinks";
import { Empty, Page, StatTile } from "@/components/ui/Layout";
import { RepoStrip } from "@/components/ui/RepoStrip";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { can, currentUserOrNull } from "@/lib/auth/require";
import { getBoard, getJiraIssues } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { describeJiraConfig, issueUrl } from "@/lib/jira/client";
import { boardSummary } from "@/lib/shared/occupancy";
import { jiraActivity } from "@/lib/shared/activity";
import { agoText } from "@/lib/shared/format";
import { jiraBranchConflicts, type JiraBranchConflict } from "@/lib/shared/jira-conflicts";
import { ENV_STATE, TONE, shortRepo } from "@/lib/shared/tokens";
import type { Claim, Environment } from "@/lib/types";
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

const TABLE_LIMIT = 5;

function JiraConflictNotice({
  conflicts,
  jira_base_url,
}: {
  conflicts: Map<string, JiraBranchConflict>;
  jira_base_url: string | null;
}) {
  if (!conflicts.size) return null;

  const ticket_ids = [...conflicts.keys()].sort();
  const repos = [...new Set([...conflicts.values()].flatMap((conflict) => conflict.repos))];

  return (
    <div
      className="mb-4 flex gap-3 rounded-2xl bg-warn-soft px-4 py-3.5 text-warn ring-1 ring-warn-soft"
      role="status"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface/70">
        <Icon name="alert" className="h-4 w-4" />
      </span>
      <div className="min-w-0 text-xs leading-5">
        <p className="font-bold">
          Branch conflict detected in {ticket_ids.length} ticket{ticket_ids.length === 1 ? "" : "s"}
        </p>
        <p className="text-warn/90">
          Tickets in In Progress or QA Testing (Stg) share the same account, branch, and{" "}
          {repos.map(shortRepo).join(", ")} repository. Assign a different branch to the affected tickets.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wide">Affected tickets</span>
          {ticket_ids.map((ticket_id) =>
            jira_base_url ? (
              <a
                key={ticket_id}
                href={issueUrl(jira_base_url, ticket_id)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${ticket_id} in Jira`}
                className="inline-flex items-center gap-1 rounded-md bg-surface/80 px-2 py-1 text-[10px] font-bold text-warn ring-1 ring-warn-soft transition hover:bg-surface hover:ring-warn"
              >
                {ticket_id}
                <Icon name="external" className="h-2.5 w-2.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <strong
                key={ticket_id}
                className="rounded-md bg-surface/80 px-2 py-1 text-[10px] ring-1 ring-warn-soft"
              >
                {ticket_id}
              </strong>
            ),
          )}
        </div>
      </div>
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

function HeldCard({ row, jira_base_url }: { row: EnvRow; jira_base_url: string | null }) {
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
              {/* No external icon here: several keys share one truncated line,
                  and an icon each would eat the width the keys need. */}
              <p className="ml-1 flex min-w-0 items-center gap-1 truncate text-[11px] text-faint">
                {row.ticketIds.map((ticket_id, index) => (
                  <span key={ticket_id} className="whitespace-nowrap">
                    <TicketLink
                      ticketKey={ticket_id}
                      source={row.claims.find((claim) => claim.id === ticket_id)?.source}
                      jiraBaseUrl={jira_base_url}
                      icon={false}
                      className="text-[11px] font-semibold text-faint hover:text-brand-fg"
                    />
                    {index < row.ticketIds.length - 1 ? "," : ""}
                  </span>
                ))}
              </p>
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
 *  message), Summary, Assignee, Status, Branch, Repos. */
function JiraUpdateRow({
  row,
  activity,
  jira_base_url,
  environments,
  claims,
}: {
  row: TicketRow;
  activity: ReturnType<typeof jiraActivity>;
  jira_base_url: string | null;
  environments: Environment[];
  claims: Claim[];
}) {
  return (
    <Tr className="group">
      <Td className="w-[23%] align-top">
        <span className="inline-flex items-center gap-1.5">
          <TicketLink
            ticketKey={row.claim.id}
            source={row.claim.source}
            jiraBaseUrl={jira_base_url}
            className="text-[13px] font-bold text-brand-fg"
          />
          {activity ? <Chip className={activity.chipClassName}>{activity.badge}</Chip> : null}
        </span>
        {row.claim.jiraUpdatedAt ? (
          <p className="mt-1 whitespace-nowrap text-[10px] font-medium text-faint">
            Updated {agoText(row.claim.jiraUpdatedAt)} ago
          </p>
        ) : null}
        {activity ? (
          <p className="mt-1.5 max-w-[22rem] whitespace-normal break-words border-l-2 border-line-2 pl-2 text-[11px] leading-4 text-muted">
            {activity.message}
          </p>
        ) : null}
      </Td>
      <Td className="w-[34%] align-top">
        <p className="max-w-[34rem] whitespace-normal break-words text-sm font-medium leading-5 text-ink-2">
          {row.claim.summary ?? "—"}
        </p>
      </Td>
      <Td className="w-[10%] align-top">
        <AvatarStack people={row.people} max={3} />
      </Td>
      <Td className="w-[14%] align-top">
        <JiraChip status={row.claim.status} />
      </Td>
      <Td className="w-[12%] align-top">
        <p className="inline-flex max-w-[12rem] whitespace-normal break-all rounded-lg bg-subtle-2 px-2 py-1 font-mono text-[11px] font-medium text-body">
          {row.claim.branch ?? row.env}
        </p>
      </Td>
      <Td className="w-[7%] align-top">
        {row.claim.repos.length ? (
          <ClaimRepoLinks
            repos={row.claim.repos}
            environment={environments.find((env) => env.id === row.serverId)}
            claims={claims}
          />
        ) : (
          <Dash />
        )}
      </Td>
    </Tr>
  );
}

export default async function DashboardPage() {
  const jira_base_url = describeJiraConfig().baseUrl;
  const [{ accounts, environments, claims, directory, settings }, issues, user, avatars] = await Promise.all([
    getBoard(),
    getJiraIssues(),
    currentUserOrNull(),
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

  // Every Jira-sourced ticket touched recently, holding a repository or not —
  // most recently updated first. Nothing here is a diff against a previous
  // sync (see lib/shared/activity.ts); it's just recency.
  const jira_rows = [...tickets, ...boardRows(issues, environments, accounts, directory, avatars)].filter(
    (row) => row.claim.source === "jira",
  );
  const branch_conflicts = jiraBranchConflicts(
    jira_rows.map((row) => ({
      ticketId: row.claim.id,
      status: row.claim.status,
      accountName: row.accountName,
      branch: row.claim.branch,
      repos: row.claim.repos,
    })),
  );
  const jiraUpdates = jira_rows
    .filter((row) => row.claim.jiraUpdatedAt)
    .sort((a, b) => new Date(b.claim.jiraUpdatedAt!).getTime() - new Date(a.claim.jiraUpdatedAt!).getTime())
    .slice(0, TABLE_LIMIT);

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
            held.map((row) => <HeldCard key={row.id} row={row} jira_base_url={jira_base_url} />)
          ) : (
            <Empty message="Nothing is held — every environment is free." />
          )}
        </div>
      </section>

      <section className="mt-7">
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              <h2 className="text-[17px] font-bold tracking-tight">Latest Jira updates</h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-xs text-faint">Most recently updated tickets, synced from Jira</p>
                {settings.jira.enabled && settings.jira.autoSync ? (
                  <JiraAutoSync interval_minutes={settings.jira.pollIntervalMinutes} />
                ) : null}
              </div>
            </div>
            {/* Courtesy, same as the nav entry: /tickets refuses without
                `all-tickets` anyway, and a link that 403s is worse than no
                link. The table above it stays — a preview of recent Jira
                activity is not the same thing as the whole backlog. */}
            {can(user, "all-tickets") ? (
              <Link href="/tickets" className="text-xs font-semibold text-brand-fg hover:underline">
                See all
              </Link>
            ) : null}
          </div>

          <JiraConflictNotice conflicts={branch_conflicts} jira_base_url={jira_base_url} />

          <Table
            className="flex-1"
            isEmpty={!jiraUpdates.length}
            empty="Nothing from Jira yet — run a sync."
            minWidth="min-w-[1100px]"
            head={
              <>
                <Th className="w-[23%]">Ticket activity</Th>
                <Th className="w-[34%]">Summary</Th>
                <Th className="w-[10%]">Assignee</Th>
                <Th className="w-[14%]">Status</Th>
                <Th className="w-[12%]">Branch</Th>
                <Th className="w-[7%]">Repos</Th>
              </>
            }
          >
            {jiraUpdates.map((row) => (
              <JiraUpdateRow
                key={`${row.claim.id}::${row.serverId ?? "none"}`}
                row={row}
                activity={jiraActivity(row, directory, user)}
                jira_base_url={jira_base_url}
                environments={environments}
                claims={claims}
              />
            ))}
          </Table>
        </div>
      </section>
    </Page>
  );
}
