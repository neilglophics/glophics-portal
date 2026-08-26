import { TicketTable } from "@/components/TicketTable";
import { Page, PageHead } from "@/components/ui/Layout";
import { requireUser } from "@/lib/auth/require";
import { Pagination } from "@/components/ui/Pagination";
import { getBoard, getSettings } from "@/lib/db/queries/board";
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
 *
 * ── Who can see it ──
 *
 * `all-tickets`, held by `superadmin` and `admin` (ADR-016). This is the whole
 * team's backlog — a lead's view of the work rather than a participant's — and
 * a member or viewer gets My tickets, the environments and the dashboard
 * instead. The nav entry is gated on the same capability, but **hiding is
 * courtesy**: requireUser() below is the boundary (invariant 3).
 *
 * Reusing `configure` would have been free and wrong for exactly the reason
 * ADR-012 gives: it happens to be held by the same two roles today, so the day
 * `member` is given `configure` this page would widen with it and nobody
 * reviewing that change would see it coming.
 *
 * ── Why this page hides statuses and My tickets does not ──
 *
 * "Active" is this page's whole claim: it answers "what is being worked on", so
 * a ticket at DONE, CLOSED or OPEN is not an answer to it — it is noise between
 * the rows somebody came here to read.
 *
 * That cut used to happen in Jira. `settings.jira.ignoredStatuses` was a
 * `status NOT IN (…)` clause in the sync's JQL, so those tickets never entered
 * the database at all, and every page in the app inherited this page's opinion
 * — including the one whose job is to show a person EVERYTHING assigned to
 * them. So the list moved here, to the read that actually wants it
 * (docs/05-DECISIONS.md ADR-014). Active tickets passes it; My tickets passes
 * nothing and shows every status.
 */
export const metadata = { title: "Active tickets · Glophics Portal" };

type Search = { page?: string };

/** Page 1 drops the parameter, so the default view has a clean URL — the same
 *  rule the href() helpers on Health and Environments follow. */
function pageHref(n: number): string {
  return n === 1 ? "/tickets" : `/tickets?page=${n}`;
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  // The boundary. Before any read, so a role that cannot see this list never
  // causes the queries behind it to run either.
  await requireUser("all-tickets");

  const search = await searchParams;
  const jiraBaseUrl = describeJiraConfig().baseUrl;
  // Sequential rather than parallel, and for the same reason My tickets is: the
  // page query needs the hide list, and the hide list is a setting. One extra
  // round trip against a page that quietly disagreed with Settings › Jira.
  const settings = await getSettings();
  const hideStatuses = settings.jira.ignoredStatuses.filter(Boolean);

  const [{ accounts, environments, claims, directory }, page, avatars] = await Promise.all([
    getBoard(),
    getTicketPage({ page: pageNumber(search.page), hideStatuses }),
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
            {/* Said out loud, because a row missing from a board reads as a
                sync problem unless something says it was left out on purpose.
                My tickets is where the hidden ones are still findable. */}
            {hideStatuses.length ? ` · hiding ${hideStatuses.join(", ")}` : ""}
          </>
        }
      />
      <TicketTable
        rows={rows}
        showHolding
        environments={environments}
        claims={claims}
        jiraBaseUrl={jiraBaseUrl}
        empty={
          hideStatuses.length
            ? "Nothing is being worked on — every ticket the last sync saw is at a hidden status."
            : "No tickets — the last sync found nothing."
        }
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
