import Link from "next/link";
import { Dash, HealthChip, Muted } from "@/components/ui/Chips";
import { Notice, Page, PageHead, StatTile } from "@/components/ui/Layout";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { getBoard } from "@/lib/db/queries/board";
import { agoText } from "@/lib/shared/format";
import { repoRows } from "@/lib/shared/view-model";

/**
 * Is each repository actually up?
 *
 * ⚠ The health data behind this page is currently only as good as whatever is
 * writing it. On Vercel a serverless function cannot reach a private hostname
 * like `backend.srv-01.internal`, so nothing can check those endpoints from the
 * cloud — see docs/06-OPEN-QUESTIONS.md Q1, which is still open.
 *
 * Until that is resolved this page must never present a stale or absent check as
 * `offline`, because an offline repo outranks everything in the derived status
 * and would paint the whole board red. `health_checked_at` is what makes the
 * difference visible: "not checked" is a different statement from "down".
 */
export const metadata = { title: "Health · Glophics Portal" };

/** How old a check may be before it stops counting as current. */
const STALE_AFTER_MS = 10 * 60 * 1000;

export default async function HealthPage() {
  const { accounts, environments, claims } = await getBoard();
  const rows = repoRows(environments, accounts, claims);

  const offline = rows.filter((r) => r.health === "offline");
  const online = rows.filter((r) => r.health === "online");
  const unconfigured = rows.filter((r) => r.health === "unconfigured");

  const everChecked = rows.filter((r) => r.healthCheckedAt);
  const newest = everChecked
    .map((r) => new Date(r.healthCheckedAt!).getTime())
    .sort((a, b) => b - a)[0];

  const noChecksYet = everChecked.length === 0 && rows.some((r) => r.url);
  const stale = !!newest && Date.now() - newest > STALE_AFTER_MS;

  return (
    <Page>
      <PageHead
        title="Health"
        sub={
          newest
            ? `Last checked ${agoText(new Date(newest).toISOString())} ago`
            : "No endpoint has been checked yet"
        }
      />

      {noChecksYet ? (
        <Notice tone="warn" title="No health checks have run">
          Every repository below shows its configured state, not a measured one. Nothing is reporting
          results yet — see <strong>Q1</strong> in the migration docs. These are <em>unknown</em>, not down.
        </Notice>
      ) : stale ? (
        <Notice tone="warn" title="Health data is stale">
          The most recent check was {agoText(new Date(newest).toISOString())} ago. Whatever reports
          health has stopped, so the states below may no longer be true.
        </Notice>
      ) : null}

      <section className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile tone="bad" label="Offline" value={offline.length} sub="need attention" icon="alert" />
        <StatTile tone="ok" label="Online" value={online.length} sub="responding" icon="check" />
        <StatTile
          tone="neutral"
          label="No URL set"
          value={unconfigured.length}
          sub="nothing to check"
          icon="plug"
        />
        <StatTile tone="brand" label="Endpoints" value={rows.length} sub="across every account" icon="servers" />
      </section>

      <Table
        isEmpty={!rows.length}
        empty="No repositories configured yet."
        head={
          <>
            <Th>Repository</Th>
            <Th>Environment</Th>
            <Th>Health</Th>
            <Th>Checked</Th>
            <Th>URL</Th>
            <Th>Held by</Th>
          </>
        }
      >
        {rows.map((row) => (
          <Tr key={`${row.serverId}::${row.repo}`}>
            <Td>
              <p className="text-sm font-semibold">{row.repo}</p>
              <p className="text-[11px] text-faint">{row.accountName}</p>
            </Td>

            <Td>
              <Link
                href={`/environments/${encodeURIComponent(row.serverId)}`}
                className="text-sm font-medium text-body hover:text-brand-fg hover:underline"
              >
                {row.env}
              </Link>
            </Td>

            <Td>
              <HealthChip health={row.health} />
            </Td>

            <Td>
              {row.healthCheckedAt ? (
                <span className="whitespace-nowrap text-xs text-body">
                  {agoText(row.healthCheckedAt)} ago
                </span>
              ) : (
                <Muted>Never</Muted>
              )}
            </Td>

            <Td>
              {row.url ? (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted hover:text-brand-fg hover:underline"
                >
                  {row.url}
                </a>
              ) : (
                <Muted>No URL configured</Muted>
              )}
            </Td>

            <Td>
              {row.claims.length ? (
                <span className="text-xs font-semibold text-brand-fg">
                  {row.claims.map((c) => c.id).join(", ")}
                </span>
              ) : (
                <Dash />
              )}
            </Td>
          </Tr>
        ))}
      </Table>
    </Page>
  );
}
