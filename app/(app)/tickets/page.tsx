import { TicketTable } from "@/components/TicketTable";
import { Page, PageHead } from "@/components/ui/Layout";
import { Pagination } from "@/components/ui/Pagination";
import { getBoard, getJiraIssues } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { describeJiraConfig } from "@/lib/jira/client";
import { pageNumber, pageWindow, paginate } from "@/lib/shared/pagination";
import { boardRows, claimRows } from "@/lib/shared/view-model";

/**
 * The whole board, one row per ticket: what is holding a repository first — the
 * question the tables were built for — then everything else the last sync saw.
 *
 * Ten rows a page, with the page in the URL. The slice happens HERE rather than
 * in SQL on purpose: getBoard() and getJiraIssues() have no LIMIT, and the order
 * you see is produced in JS — claimRows() sorts by minutes-until-free and
 * boardRows() invents a Claim per Jira issue before sorting. A LIMIT/OFFSET
 * would page a different order from the one on screen. So this paginates the
 * render, not the query: every request still reads the whole board.
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
  const [{ accounts, environments, claims, directory }, issues, avatars] = await Promise.all([
    getBoard(),
    getJiraIssues(),
    avatarVersions(),
  ]);

  const holding = claimRows(environments, accounts, claims, directory, avatars);
  const rest = boardRows(issues, environments, accounts, directory, avatars);
  const rows = [...holding, ...rest];

  const paged = paginate(rows, pageNumber(search.page));

  return (
    <Page>
      <PageHead
        title="Active tickets"
        // Still the whole board, not the page: this is the summary, and the
        // pager below says which rows are actually on screen.
        sub={
          <>
            {holding.length} holding a repository
            {rest.length ? `, ${rest.length} more on the board` : ""}
          </>
        }
      />
      <TicketTable
        rows={paged.items}
        showHolding
        environments={environments}
        claims={claims}
        jiraBaseUrl={jiraBaseUrl}
        empty="No tickets — the last sync found nothing."
      />
      <Pagination
        {...paged}
        label="tickets"
        href={pageHref}
        window={pageWindow(paged.page, paged.pageCount)}
      />
    </Page>
  );
}
