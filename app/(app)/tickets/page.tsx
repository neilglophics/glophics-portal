import { TicketTable } from "@/components/TicketTable";
import { Page, PageHead } from "@/components/ui/Layout";
import { getBoard, getJiraIssues } from "@/lib/db/queries/board";
import { avatarVersions } from "@/lib/db/queries/avatars";
import { boardRows, claimRows } from "@/lib/shared/view-model";

/**
 * The whole board, one row per ticket: what is holding a repository first — the
 * question the tables were built for — then everything else the last sync saw.
 */
export const metadata = { title: "Active tickets · Glophics Portal" };

export default async function TicketsPage() {
  const [{ accounts, environments, claims, directory }, issues, avatars] = await Promise.all([
    getBoard(),
    getJiraIssues(),
    avatarVersions(),
  ]);

  const holding = claimRows(environments, accounts, claims, directory, avatars);
  const rest = boardRows(issues, environments, accounts, directory, avatars);
  const rows = [...holding, ...rest];

  return (
    <Page>
      <PageHead
        title="Active tickets"
        sub={
          <>
            {holding.length} holding a repository
            {rest.length ? `, ${rest.length} more on the board` : ""}
          </>
        }
      />
      <TicketTable rows={rows} showHolding empty="No tickets — the last sync found nothing." />
    </Page>
  );
}
