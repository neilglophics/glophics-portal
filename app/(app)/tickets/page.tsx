import { TicketTable } from "@/components/TicketTable";
import { Page, PageHead } from "@/components/ui/Layout";
import { Pagination } from "@/components/ui/Pagination";
import { getBoard } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { getTicketPage } from "@/lib/db/queries/tickets";
import { describeJiraConfig } from "@/lib/jira/client";
import { pageNumber, pageWindow } from "@/lib/shared/pagination";
import { boardRows, claimRows } from "@/lib/shared/view-model";

/**
 * The whole board, one row per ticket: what is holding a repository first — the
 * question the tables were built for — then everything else the last sync saw.
 *
 * Ten rows a page, with the page in the URL, and the slice taken by Postgres —
 * getTicketPage() returns only the ten claims/issues on screen plus the totals,
 * so the backlog can grow without this page's payload growing with it. The
 * ordering rule lives in that query now; see lib/db/queries/tickets.ts.
 *
 * getBoard() is still a whole-board read, and stays one: accounts, environments
 * and the directory are the small lookup tables every row resolves against, and
 * the app shell above this page has already loaded them. `claims` comes back
 * with it because a repository badge has to say whether a repo is occupied by
 * SOMEBODY, not just by a ticket on this page.
 */
export const metadata = { title: "Active tickets · Glophics Portal" };

type Search = { page?: string };

/** Page 1 drops the parameter, so the default view has a clean URL — the same
 *  rule the href() helpers on Health and Environments follow. */
function pageHref(n: number): string {
  return n === 1 ? "/tickets" : `/tickets?page=${n}`;
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const jiraBaseUrl = describeJiraConfig().baseUrl;
  const [{ accounts, environments, claims, directory }, page, avatars] = await Promise.all([
    getBoard(),
    getTicketPage({ page: pageNumber(search.page) }),
    avatarVersions(),
  ]);

  // claimRows() and boardRows() sort again, which is safe and not redundant:
  // they order by minutes-until-free, a floor() of the same end_time the query
  // ordered by, so the comparator agrees with SQL and the sort is stable. What
  // they are really here for is resolving each row against the environment,
  // account and directory it belongs to.
  const rows = [
    ...claimRows(environments, accounts, page.claims, directory, avatars),
    ...boardRows(page.issues, environments, accounts, directory, avatars),
  ];

  return (
    <Page>
      <PageHead
        title="Active tickets"
        // Still the whole board, not the page: these are counts from the query
        // rather than lengths of what came back, and the pager below says which
        // rows are actually on screen.
        sub={
          <>
            {page.holdingTotal} holding a repository
            {page.issueTotal ? `, ${page.issueTotal} more on the board` : ""}
          </>
        }
      />
      <TicketTable
        rows={rows}
        showHolding
        environments={environments}
        claims={claims}
        jiraBaseUrl={jiraBaseUrl}
        empty="No tickets — the last sync found nothing."
      />
      <Pagination
        {...page.position}
        label="tickets"
        href={pageHref}
        window={pageWindow(page.position.page, page.position.pageCount)}
      />
    </Page>
  );
}
