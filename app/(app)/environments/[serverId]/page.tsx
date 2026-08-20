import Link from "next/link";
import { notFound } from "next/navigation";
import { AvatarStack } from "@/components/ui/Avatar";
import { Dash, HealthChip, JiraChip, Muted, StatusChip } from "@/components/ui/Chips";
import { Card, Notice, Page, PageHead } from "@/components/ui/Layout";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { AssignButton, ForceFreeClaimButton, ForceFreeServerButton, NoteButton } from "@/components/env/EnvActions";
import { currentUserOrNull, can } from "@/lib/auth/require";
import { getBoard } from "@/lib/db/queries/board";
import { agoText, formatDateTime } from "@/lib/shared/format";
import { shortRepo } from "@/lib/shared/tokens";
import { envRow, isUrgent, leftText, minutesLeft, peopleOf } from "@/lib/shared/view-model";
import { repoClaims } from "@/lib/shared/occupancy";

/**
 * One environment, broken down per repository — which repos are free, and which
 * ticket holds each of the others.
 *
 * The legacy app expanded this inline inside the environments table. A real route
 * is better: it is linkable, the back button works, and the table above does not
 * have to carry expansion state.
 */
export async function generateMetadata({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const { environments } = await getBoard();
  const env = environments.find((e) => e.id === decodeURIComponent(serverId));
  return { title: env ? `${env.name} · Glophics Portal` : "Environment · Glophics Portal" };
}

export default async function EnvironmentDetailPage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
  const { serverId } = await params;
  const id = decodeURIComponent(serverId);

  const [board, user] = await Promise.all([getBoard(), currentUserOrNull()]);
  const { accounts, environments, claims, directory, settings } = board;

  const env = environments.find((e) => e.id === id);
  if (!env) notFound();

  const row = envRow(env, accounts, claims, directory);
  const mayClaim = can(user, "claim");

  return (
    <Page>
      <div className="pb-2">
        <Link href="/environments" className="text-xs font-semibold text-muted hover:text-brand-fg hover:underline">
          ← All environments
        </Link>
      </div>

      <PageHead
        title={row.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span>{row.accountName}</span>
            <StatusChip status={row.state} />
          </span>
        }
        actions={
          mayClaim ? (
            <>
              <AssignButton
                serverId={row.id}
                freeRepos={row.freeRepos}
                directory={directory}
                settings={settings}
                disabled={!row.freeRepos.length}
              />
              <ForceFreeServerButton
                serverId={row.id}
                serverName={row.name}
                claimCount={row.claims.length}
              />
            </>
          ) : (
            <Muted>Your role can look but not book.</Muted>
          )
        }
      />

      {row.offline.length ? (
        <Notice tone="bad" title={`${row.offline.length} repository is not reachable`}>
          {row.offline.join(", ")} — an offline repository outranks claim state, which is why this
          environment reads as <strong>Server down</strong> regardless of what is booked.
        </Notice>
      ) : null}

      {/* ---- per-repository breakdown ---- */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {row.repos.map((repo) => {
          const holders = repoClaims(claims, row.id, repo.repoName);
          const people = peopleOf(holders, directory);

          return (
            <Card key={repo.repoName}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-subtle-2 px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted">
                      {shortRepo(repo.repoName)}
                    </span>
                    <h3 className="truncate text-sm font-bold">{repo.repoName}</h3>
                  </div>
                  <div className="mt-2">
                    <HealthChip health={repo.health} />
                  </div>
                </div>
                {mayClaim ? (
                  <NoteButton serverId={row.id} repoName={repo.repoName} note={repo.note} />
                ) : null}
              </div>

              <div className="mt-4 space-y-2 border-t border-line-soft pt-3.5">
                {repo.url ? (
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-xs text-muted hover:text-brand-fg hover:underline"
                  >
                    {repo.url}
                  </a>
                ) : (
                  <Muted>No URL configured — nothing to check</Muted>
                )}

                {repo.healthCheckedAt ? (
                  <p className="text-[11px] text-faint">Checked {agoText(repo.healthCheckedAt)} ago</p>
                ) : (
                  <p className="text-[11px] text-faint">Never checked</p>
                )}
              </div>

              <div className="mt-3.5 border-t border-line-soft pt-3.5">
                {holders.length ? (
                  <>
                    <div className="flex items-center gap-2.5">
                      <AvatarStack people={people} />
                      <span className="truncate text-[11px] font-semibold text-brand-fg">
                        {holders.map((c) => c.id).join(", ")}
                      </span>
                    </div>
                    {/* More than one claim on one repo is legal, and the legacy
                        UI called it "Shared". Worth saying out loud. */}
                    {holders.length > 1 ? (
                      <p className="mt-1.5 text-[11px] font-medium text-warn">
                        Shared by {holders.length} tickets
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs font-medium text-ok">Free — ready to book</p>
                )}
              </div>

              {repo.note ? (
                <p className="mt-3 rounded-xl bg-subtle px-3 py-2 text-xs leading-relaxed text-body">
                  {repo.note}
                </p>
              ) : null}
            </Card>
          );
        })}
      </section>

      {/* ---- claims on this environment ---- */}
      <section className="mt-7">
        <h2 className="pb-4 text-[17px] font-bold tracking-tight">
          Claims on {row.name}
          <span className="ml-2 text-xs font-semibold text-faint">{row.claims.length}</span>
        </h2>

        <Table
          isEmpty={!row.claims.length}
          empty="Nothing is holding this environment."
          minWidth="min-w-[760px]"
          head={
            <>
              <Th>Holders</Th>
              <Th>Ticket</Th>
              <Th>Status</Th>
              <Th>Repositories</Th>
              <Th>Booked</Th>
              <Th className="text-right">Frees in</Th>
              {mayClaim ? <Th className="text-right" /> : null}
            </>
          }
        >
          {row.claims.map((claim) => {
            const people = peopleOf([claim], directory);
            const minutes = minutesLeft(claim);

            return (
              <Tr key={claim.id}>
                <Td>
                  <AvatarStack people={people} />
                </Td>
                <Td>
                  <span className="whitespace-nowrap text-xs font-semibold text-brand-fg">{claim.id}</span>
                  <p className="text-[11px] text-faint">{claim.source === "jira" ? "From Jira" : "Manual"}</p>
                </Td>
                <Td>
                  <JiraChip status={claim.status} />
                </Td>
                <Td>
                  <span className="text-xs text-body">{claim.repos.map(shortRepo).join(" ")}</span>
                </Td>
                <Td>
                  {claim.startTime || claim.endTime ? (
                    <span className="whitespace-nowrap text-[11px] text-muted">
                      {formatDateTime(claim.startTime) ?? "—"} → {formatDateTime(claim.endTime) ?? "—"}
                    </span>
                  ) : (
                    <Dash />
                  )}
                </Td>
                <Td className="text-right">
                  <span
                    className={`whitespace-nowrap text-sm font-semibold ${
                      isUrgent(minutes) ? "text-warn" : "text-muted"
                    }`}
                  >
                    {leftText(minutes)}
                  </span>
                </Td>
                {mayClaim ? (
                  <Td className="text-right">
                    <ForceFreeClaimButton
                      claimId={claim.id}
                      repos={claim.repos}
                      holders={people.map((p) => p.name).join(", ")}
                    />
                  </Td>
                ) : null}
              </Tr>
            );
          })}
        </Table>
      </section>
    </Page>
  );
}
