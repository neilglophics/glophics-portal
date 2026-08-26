import Link from "next/link";
import { RefreshTickets } from "@/components/tickets/RefreshTickets";
import { TicketTable } from "@/components/TicketTable";
import { FilterLink } from "@/components/ui/Chips";
import { Notice, Page, PageHead } from "@/components/ui/Layout";
import { Pagination } from "@/components/ui/Pagination";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard, getJiraSyncState, getSettings } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { getTicketPage, statusKey } from "@/lib/db/queries/tickets";
import { describeJiraConfig } from "@/lib/jira/client";
import { agoText } from "@/lib/shared/format";
import { identityValues } from "@/lib/shared/mine";
import { pageNumber, pageWindow } from "@/lib/shared/pagination";
import { boardRows, claimRows } from "@/lib/shared/view-model";

/**
 * Everything assigned to whoever is signed in — holding a repository or not.
 *
 * "Mine" is resolved through the account's link into the people directory and
 * the Jira labels that person answers to, never through a copy stored on the
 * login. So fixing a mistyped label in the directory fixes this page with it.
 *
 * Paged by Postgres, like Active tickets. The filter has to go down WITH the
 * page: counting in SQL and then filtering in JS would number the pages off the
 * whole board and then show ten rows of somebody's four tickets. So
 * identityValues() runs here — that is the fiddly half, and it stays in the one
 * place — and the strings it produces go to the query, which only asks whether a
 * ticket names any of them. See lib/db/queries/tickets.ts.
 *
 * The cost is that this page's reads are sequential rather than parallel: the
 * identity values need the directory, and the directory comes from getBoard().
 * One extra round trip, against not fetching the Jira cache at all.
 *
 * ── The status chips ──
 *
 * `?status=` narrows the list, and like the page number it lives in the URL:
 * "here is everything of mine in QA" is then a link somebody can send. Every
 * chip is a plain <Link>, so this page stays server-rendered — the only client
 * JavaScript here is the Refresh button. The counts come back from the same
 * aggregate that sizes the pager, which is what stops a chip reading 13 sitting
 * above a pager reading 12.
 *
 * ── Every status, deliberately ──
 *
 * This page passes NO `hideStatuses`, and that is the difference between it and
 * Active tickets. "Everything assigned to me" has to include the closed, the
 * cancelled and the not-yet-started, or it is answering a narrower question
 * than its title claims. Active tickets hides those because it is asking "what
 * is being worked on"; this one is asking "what is mine".
 *
 * That was not possible until ADR-014. `settings.jira.ignoredStatuses` used to
 * cut those statuses out of the sync's own JQL, so they were not hidden from
 * this page — they had never been fetched, and no filter here could have
 * brought them back.
 *
 * What is still a bound is the sync window: `updated >= -30d` on a full pass,
 * so a ticket of yours untouched in Jira for over a month is not in the cache
 * for this page to find. The Refresh button forces a full pass — it makes the
 * list current, and as wide as that window allows.
 */
export const metadata = { title: "My tickets · Glophics Portal" };

type Search = { page?: string; status?: string };

/** Page 1 and "every status" drop their parameter, so the default view has a
 *  clean URL — the rule the Health and Environments pages already follow. */
function ticketsHref({ status, page }: { status?: string | null; page?: number }): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (page && page > 1) params.set("page", String(page));

  const query = params.toString();
  return query ? `/my-tickets?${query}` : "/my-tickets";
}

export default async function MyTicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const jiraBaseUrl = describeJiraConfig().baseUrl;
  const [{ accounts, environments, claims, directory }, user, avatars, settings, syncState] =
    await Promise.all([
      getBoard(),
      currentUserOrNull(),
      avatarVersions(),
      getSettings(),
      getJiraSyncState(),
    ]);

  // An empty set matches nothing, which is what claimIsMine() does too: a login
  // linked to nobody has no tickets rather than everybody's.
  const values = identityValues(user, directory);

  // Normalised here as well as inside the query, because the chips compare
  // against it: `?status=IN%20PROGRESS` must light the same chip that
  // `?status=in progress` does, and both must be the one the query filtered on.
  const selected = search.status ? statusKey(search.status) : null;
  const page = await getTicketPage({
    page: pageNumber(search.page),
    mine: [...values],
    status: selected,
  });

  const rows = [
    ...claimRows(environments, accounts, page.claims, directory, avatars),
    ...boardRows(page.issues, environments, accounts, directory, avatars),
  ];

  // The chips are counted over the WHOLE list, so this is the unfiltered total;
  // `page.position.total` is the cut currently on screen.
  const total = page.statuses.reduce((sum, entry) => sum + entry.total, 0);
  const picked = selected ? page.statuses.find((entry) => entry.key === selected) : null;
  // A `?status=` naming something nobody is at still has to be nameable in the
  // sentence that says so, so it falls back to whatever was typed.
  const statusLabel = picked?.status ?? search.status ?? "";
  const hiddenElsewhere = settings.jira.ignoredStatuses.filter(Boolean);

  return (
    <Page>
      <PageHead
        title="My tickets"
        // Counts from the query, not the length of this page. Freshness is half
        // the answer to "is this everything?", so it is said here rather than
        // left to the header pill.
        sub={
          <>
            {total === 0
              ? "Nothing is assigned to you right now"
              : selected
                ? `${page.position.total} of ${total} ticket${total === 1 ? "" : "s"} · ${statusLabel}`
                : `${total} ticket${total === 1 ? "" : "s"}, ${page.holdingTotal} holding a repository`}
            {syncState.lastSyncAt
              ? ` · synced ${agoText(syncState.lastSyncAt)} ago`
              : " · never synced"}
          </>
        }
        actions={<RefreshTickets jiraEnabled={settings.jira.enabled} />}
      />

      {/* A login with no directory link and no Jira names can never match a
          ticket, which reads as "I have no work" rather than as a setup gap.
          Saying so is the difference between the two. */}
      {user && !user.directoryUserId && !user.jiraNames.length ? (
        <Notice tone="warn" title="Your login is not linked to anyone on the board">
          Until a super admin points it at your entry under <strong>Users</strong>, no ticket can be
          recognised as yours — even if Jira has your name on it.
        </Notice>
      ) : null}

      {/* One status is not a choice, so the row would be noise — the same reason
          the pager hides itself on a single page. It still renders while a
          filter is on, or a narrowed view could have no way back. */}
      {page.statuses.length > 1 || selected ? (
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <FilterLink href={ticketsHref({})} label="All" count={total} active={!selected} />
          {page.statuses.map((entry) => (
            <FilterLink
              key={entry.key}
              // No page number: a different status is a different list, and page
              // 4 of the old one is not a place in the new one.
              href={ticketsHref({ status: entry.key })}
              label={entry.status}
              count={entry.total}
              active={selected === entry.key}
            />
          ))}
          {selected ? (
            <Link
              href="/my-tickets"
              className="ml-1 text-[11px] font-semibold text-brand-fg hover:underline"
            >
              Reset
            </Link>
          ) : null}
        </div>
      ) : null}

      <p className="pb-5 text-[11px] text-faint">
        Every status, including{" "}
        {hiddenElsewhere.length ? (
          <>
            <span className="font-semibold">{hiddenElsewhere.join(", ")}</span> — which Active
            tickets hides and this page does not.{" "}
          </>
        ) : (
          <>the finished and the not-yet-started. </>
        )}
        The one bound is the sync window: a ticket Jira has not touched in 30 days is not in the
        cache to find.
      </p>

      <TicketTable
        rows={rows}
        showHolding
        environments={environments}
        claims={claims}
        jiraBaseUrl={jiraBaseUrl}
        empty={
          selected
            ? `Nothing of yours is at ${statusLabel}.`
            : "Nothing on the board is assigned to you."
        }
      />
      <Pagination
        {...page.position}
        label="tickets"
        // The status rides along, or page 2 would silently widen back to
        // everything.
        href={(n) => ticketsHref({ status: selected, page: n })}
        window={pageWindow(page.position.page, page.position.pageCount)}
      />
    </Page>
  );
}
