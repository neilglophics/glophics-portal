import { TicketTable } from "@/components/TicketTable";
import { Notice, Page, PageHead } from "@/components/ui/Layout";
import { Pagination } from "@/components/ui/Pagination";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { getTicketPage } from "@/lib/db/queries/tickets";
import { describeJiraConfig } from "@/lib/jira/client";
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
 */
export const metadata = { title: "My tickets · Glophics Portal" };

type Search = { page?: string };

function pageHref(n: number): string {
  return n === 1 ? "/my-tickets" : `/my-tickets?page=${n}`;
}

export default async function MyTicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const jiraBaseUrl = describeJiraConfig().baseUrl;
  const [{ accounts, environments, claims, directory }, user, avatars] = await Promise.all([
    getBoard(),
    currentUserOrNull(),
    avatarVersions(),
  ]);

  // An empty set matches nothing, which is what claimIsMine() does too: a login
  // linked to nobody has no tickets rather than everybody's.
  const values = identityValues(user, directory);
  const page = await getTicketPage({ page: pageNumber(search.page), mine: [...values] });

  const rows = [
    ...claimRows(environments, accounts, page.claims, directory, avatars),
    ...boardRows(page.issues, environments, accounts, directory, avatars),
  ];

  return (
    <Page>
      <PageHead
        title="My tickets"
        // Counts from the query, not the length of this page.
        sub={
          page.position.total
            ? `${page.position.total} ticket${page.position.total === 1 ? "" : "s"}, ` +
              `${page.holdingTotal} holding a repository`
            : "Nothing is assigned to you right now"
        }
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

      <TicketTable
        rows={rows}
        showHolding
        environments={environments}
        claims={claims}
        jiraBaseUrl={jiraBaseUrl}
        empty="Nothing on the board is assigned to you."
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
