import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { Chip, JiraChip } from "@/components/ui/Chips";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { shortRepo } from "@/lib/shared/tokens";
import { isUrgent, leftText, type TicketRow } from "@/lib/shared/view-model";

/**
 * One table for every ticket list — Active tickets, My tickets, In use.
 * Ported from public/js/ui/ticket-table.js.
 *
 * `holding` is the only thing that separates a claim from any other ticket the
 * sync saw, so both kinds render here and the column says which.
 */
export function TicketTable({
  rows,
  empty,
  showHolding = false,
}: {
  rows: TicketRow[];
  empty: string;
  /** Show the "Holding" column. Off for lists that are all one kind. */
  showHolding?: boolean;
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
            <span className="whitespace-nowrap text-xs font-semibold text-brand-fg">{row.claim.id}</span>
          </Td>

          <Td>
            <JiraChip status={row.claim.status} />
          </Td>

          {showHolding ? (
            <Td>
              {row.holding && row.claim.repos.length ? (
                <Chip className="bg-warn-soft text-warn">{row.claim.repos.map(shortRepo).join(" ")}</Chip>
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
