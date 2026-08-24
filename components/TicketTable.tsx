import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { JiraChip } from "@/components/ui/Chips";
import { ClaimRepoLinks, TicketLink } from "@/components/ui/JiraLinks";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { type TicketRow, isUrgent, leftText } from "@/lib/shared/view-model";
import type { Claim, Environment } from "@/lib/types";

/**
 * One table for every ticket list — Active tickets, My tickets, In use.
 * Ported from public/js/ui/ticket-table.js.
 *
 * `holding` is the only thing that separates a claim from any other ticket the
 * sync saw, so both kinds render here and the column says which.
 *
 * The Ticket and Holding columns are addresses rather than labels — the key
 * opens the issue in Jira, each repository badge opens that repository. Both
 * degrade to plain text on their own terms; see components/ui/JiraLinks.tsx.
 */
export function TicketTable({
  rows,
  empty,
  showHolding = false,
  environments = [],
  claims = [],
  jiraBaseUrl = null,
}: {
  rows: TicketRow[];
  empty: string;
  /** Show the "Holding" column. Off for lists that are all one kind. */
  showHolding?: boolean;
  /** Where the repository URLs and health verdicts live. Without them a badge
   *  cannot say whether the repository is up. */
  environments?: Environment[];
  /** Every claim on the board — what makes a badge able to say "occupied". */
  claims?: Claim[];
  /** From describeJiraConfig(). Null when Jira is not configured. */
  jiraBaseUrl?: string | null;
}) {
  return (
    <Table
      isEmpty={!rows.length}
      empty={empty}
      head={
        <>
          <Th>Holders</Th>
          <Th>Environment</Th>
          <Th>Ticket</Th>
          <Th>Status</Th>
          {showHolding ? <Th>Holding</Th> : null}
          <Th>Summary</Th>
          <Th className="text-right">Frees in</Th>
        </>
      }
    >
      {rows.map((row) => (
        <Tr key={`${row.claim.id}::${row.serverId ?? "none"}`}>
          <Td>
            <AvatarStack people={row.people} />
          </Td>

          <Td>
            {row.serverId ? (
              <Link href={`/environments/${encodeURIComponent(row.serverId)}`} className="group">
                <p className="truncate text-sm font-semibold group-hover:text-brand-fg group-hover:underline">
                  {row.env}
                </p>
                <p className="truncate text-[11px] text-faint">{row.accountName}</p>
              </Link>
            ) : (
              <>
                <p className="truncate text-sm font-semibold text-muted">{row.env}</p>
                {/* No environment matched, which is the Not-tracked case. Saying
                    so here stops the row reading as a placeholder. */}
                <p className="truncate text-[11px] text-warn">Not matched to an environment</p>
              </>
            )}
          </Td>

          <Td>
            <TicketLink
              ticketKey={row.claim.id}
              source={row.claim.source}
              jiraBaseUrl={jiraBaseUrl}
            />
          </Td>

          <Td>
            <JiraChip status={row.claim.status} />
          </Td>

          {showHolding ? (
            <Td>
              {row.holding && row.claim.repos.length ? (
                <ClaimRepoLinks
                  repos={row.claim.repos}
                  environment={environments.find((env) => env.id === row.serverId)}
                  claims={claims}
                />
              ) : (
                <span className="text-[11px] text-faint">Nothing</span>
              )}
            </Td>
          ) : null}

          <Td>
            <span className="text-sm text-body">{row.claim.summary || row.claim.note || "—"}</span>
          </Td>

          <Td className="text-right">
            <span
              className={`whitespace-nowrap text-sm font-semibold ${
                isUrgent(row.minutesLeft) ? "text-warn" : "text-muted"
              }`}
            >
              {leftText(row.minutesLeft)}
            </span>
          </Td>
        </Tr>
      ))}
    </Table>
  );
}
