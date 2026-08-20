import { Chip } from "@/components/ui/Chips";
import { Notice, Page, PageHead } from "@/components/ui/Layout";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { getJiraSkipped } from "@/lib/db/queries/board";

/**
 * Tickets the sync could not place, with the reason and the fix.
 *
 * This page exists so a mis-filled ticket is *visible* rather than silently
 * missing. Matching is exact on Account Name + Branch + Repository and never
 * guesses, so anything unmatched lands here by design rather than by failure.
 */
export const metadata = { title: "Not tracked · Glophics Portal" };

/**
 * The reason strings are produced by lib/jira/matching.ts, so the advice can be
 * specific rather than a generic "check the ticket".
 */
function fixFor(reason: string): string {
  const text = reason.toLowerCase();
  if (text.includes("account name is empty")) return "Fill in the ticket's Account Name field.";
  if (text.includes("branch is empty")) return "Fill in the ticket's Branch field.";
  if (text.includes("no account named")) return "Add that account under Settings, or correct the ticket.";
  if (text.includes("no environment named")) return "Add that environment under Settings, or correct the Branch.";
  if (text.includes("repository field is empty")) return "Fill in the ticket's Repository field.";
  if (text.includes("match any repo")) return "Use storefront, backend or admin — or an accepted synonym.";
  return "Correct the ticket in Jira, then sync again.";
}

export default async function NotTrackedPage() {
  const skipped = await getJiraSkipped();

  return (
    <Page>
      <PageHead
        title="Not tracked"
        sub={
          skipped.length
            ? `${skipped.length} ticket${skipped.length === 1 ? "" : "s"} could not be matched to an environment`
            : "Every ticket the last sync saw was matched"
        }
      />

      {skipped.length ? (
        <Notice tone="warn" title="These tickets are holding nothing">
          Each one reached an occupying status but could not be matched, so the environment it meant to
          claim still reads as free. Fix the ticket in Jira and the next sync picks it up.
        </Notice>
      ) : null}

      <Table
        isEmpty={!skipped.length}
        empty="Nothing was skipped — every ticket matched an environment."
        head={
          <>
            <Th>Ticket</Th>
            <Th>Status</Th>
            <Th>Account</Th>
            <Th>Branch</Th>
            <Th>Why it was skipped</Th>
            <Th>What to do</Th>
          </>
        }
      >
        {skipped.map((row) => (
          <Tr key={row.key}>
            <Td>
              <span className="whitespace-nowrap text-xs font-semibold text-brand-fg">{row.key}</span>
            </Td>
            <Td>{row.status ? <Chip className="bg-subtle-2 text-muted">{row.status}</Chip> : "—"}</Td>
            <Td>
              <span className="text-sm text-body">{row.accountName || "—"}</span>
            </Td>
            <Td>
              <span className="text-sm text-body">{row.branch || "—"}</span>
            </Td>
            <Td>
              <span className="text-sm text-bad">{row.reason}</span>
            </Td>
            <Td>
              <span className="text-xs text-muted">{fixFor(row.reason)}</span>
            </Td>
          </Tr>
        ))}
      </Table>
    </Page>
  );
}
