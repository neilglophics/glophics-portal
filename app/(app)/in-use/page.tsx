import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { Chip, JiraChip } from "@/components/ui/Chips";
import { Page, PageHead, StatTile } from "@/components/ui/Layout";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { getBoard } from "@/lib/db/queries/board";
import { shortRepo } from "@/lib/shared/tokens";
import { isUrgent, leftText, minutesLeft, nullsLast, peopleOf } from "@/lib/shared/view-model";

/**
 * One row per (claim × repository) — what "in use" actually means.
 *
 * The ticket pages count tickets; this counts *held repositories*, which is the
 * number that decides whether anyone can deploy. A ticket holding three repos is
 * one row there and three here, deliberately.
 */
export const metadata = { title: "In use · Glophics Portal" };

export default async function InUsePage() {
  const { accounts, environments, claims, directory } = await getBoard();

  const rows = claims
    .flatMap((claim) => {
      const env = environments.find((e) => e.id === claim.serverId) ?? null;
      const account = env ? accounts.find((a) => a.id === env.accountId) : null;

      return claim.repos.map((repo) => ({
        claim,
        repo,
        serverId: env?.id ?? null,
        env: env?.name ?? claim.branch ?? "—",
        accountName: account?.displayName ?? claim.accountName ?? "—",
        minutesLeft: minutesLeft(claim),
        people: peopleOf([claim], directory),
      }));
    })
    // Soonest to free first — the question people actually ask.
    .sort((a, b) => nullsLast(a.minutesLeft) - nullsLast(b.minutesLeft));

  const expiring = rows.filter((r) => isUrgent(r.minutesLeft)).length;
  const noEnd = rows.filter((r) => r.minutesLeft === null).length;

  return (
    <Page>
      <PageHead
        title="In use"
        sub={`${rows.length} repositor${rows.length === 1 ? "y is" : "ies are"} held right now`}
      />

      <section className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-3">
        <StatTile tone="warn" label="Held" value={rows.length} sub="repositories" icon="clock" />
        <StatTile
          tone="brand"
          label="Freeing within the hour"
          value={expiring}
          sub="soonest first"
          icon="clock"
        />
        <StatTile
          tone="neutral"
          label="No end time"
          value={noEnd}
          sub="held until freed by hand"
          icon="alert"
        />
      </section>

      <Table
        isEmpty={!rows.length}
        empty="Nothing is held — every repository is free."
        head={
          <>
            <Th>Holders</Th>
            <Th>Repository</Th>
            <Th>Environment</Th>
            <Th>Ticket</Th>
            <Th>Status</Th>
            <Th className="text-right">Frees in</Th>
          </>
        }
      >
        {rows.map((row) => (
          <Tr key={`${row.claim.id}::${row.serverId}::${row.repo}`}>
            <Td>
              <AvatarStack people={row.people} />
            </Td>

            <Td>
              <Chip className="bg-warn-soft text-warn">{shortRepo(row.repo)}</Chip>
              <span className="ml-2 text-xs text-muted">{row.repo}</span>
            </Td>

            <Td>
              {row.serverId ? (
                <Link href={`/environments/${encodeURIComponent(row.serverId)}`} className="group block min-w-0">
                  <span className="block truncate text-sm font-semibold group-hover:text-brand-fg group-hover:underline">
                    {row.env}
                  </span>
                  <span className="block truncate text-[11px] text-faint">{row.accountName}</span>
                </Link>
              ) : (
                <>
                  <p className="truncate text-sm font-semibold text-muted">{row.env}</p>
                  <p className="truncate text-[11px] text-faint">{row.accountName}</p>
                </>
              )}
            </Td>

            <Td>
              <span className="whitespace-nowrap text-xs font-semibold text-brand-fg">{row.claim.id}</span>
            </Td>

            <Td>
              <JiraChip status={row.claim.status} />
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
    </Page>
  );
}
