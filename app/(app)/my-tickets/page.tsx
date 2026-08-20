import { TicketTable } from "@/components/TicketTable";
import { Notice, Page, PageHead } from "@/components/ui/Layout";
import { currentUserOrNull } from "@/lib/auth/require";
import { getBoard, getJiraIssues } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { claimIsMine, identityValues } from "@/lib/shared/mine";
import { boardRows, claimRows } from "@/lib/shared/view-model";

/**
 * Everything assigned to whoever is signed in — holding a repository or not.
 *
 * "Mine" is resolved through the account's link into the people directory and
 * the Jira labels that person answers to, never through a copy stored on the
 * login. So fixing a mistyped label in the directory fixes this page with it.
 */
export const metadata = { title: "My tickets · Glophics Portal" };

export default async function MyTicketsPage() {
  const [{ accounts, environments, claims, directory }, issues, user, avatars] = await Promise.all([
    getBoard(),
    getJiraIssues(),
    currentUserOrNull(),
    avatarVersions(),
  ]);

  const values = identityValues(user, directory);
  const all = [
    ...claimRows(environments, accounts, claims, directory, avatars),
    ...boardRows(issues, environments, accounts, directory, avatars),
  ];
  const rows = all.filter((row) => claimIsMine(row.claim, values, directory));

  const holding = rows.filter((r) => r.holding).length;

  return (
    <Page>
      <PageHead
        title="My tickets"
        sub={
          rows.length
            ? `${rows.length} ticket${rows.length === 1 ? "" : "s"}, ${holding} holding a repository`
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

      <TicketTable rows={rows} showHolding empty="Nothing on the board is assigned to you." />
    </Page>
  );
}
