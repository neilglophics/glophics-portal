import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Sidebar, type AccountRollup } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { PusherProvider } from "@/components/providers/PusherProvider";
import { PresenceProvider } from "@/components/providers/PresenceProvider";
import { UnreadProvider } from "@/components/providers/UnreadProvider";
import { Toaster } from "@/components/ui/Toaster";
import { getBoard, getJiraSkippedCount, getJiraSyncState } from "@/lib/db/queries/board";
import { currentUserOrNull } from "@/lib/auth/require";
import { displayStatus } from "@/lib/shared/occupancy";
import { myClaims } from "@/lib/shared/mine";
import { totalUnread } from "@/lib/db/queries/chat";
import { avatarUrl, avatarVersions } from "@/lib/db/queries/avatars";
import { roleCan } from "@/lib/shared/roles";
import type { NavCounts } from "@/lib/shared/nav";
import type { EnvStatus } from "@/lib/types";

/**
 * The shell for everything behind the sign-in gate.
 *
 * Middleware has already checked that a session cookie *exists*; this is where
 * it is actually resolved, because that needs the Node runtime and a database.
 * A cookie that does not resolve — expired, revoked, or forged — lands here and
 * is sent back to /login.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUserOrNull();
  // `expired` tells the sign-in screen that a cookie arrived and did not
  // resolve, so it can clear the dead one and say what happened. Without it a
  // stale cookie would be carried around silently, costing a wasted bounce
  // through here on every navigation.
  if (!user) redirect("/login?expired=1");

  const [board, syncState, skipped, unreadChats, avatars] = await Promise.all([
    getBoard(),
    getJiraSyncState(),
    getJiraSkippedCount(),
    // Skipped entirely for a role without `chat`: there is no badge to show, and
    // counting would be a query answering a question nobody asked.
    roleCan(user.role, "chat") ? totalUnread(user.id) : Promise.resolve(0),
    avatarVersions(),
  ]);

  const { accounts, environments, claims, directory, settings } = board;

  // Badge counts. Derived here rather than stored, same as occupancy.
  const repoOffline = environments.reduce(
    (n, env) => n + env.repos.filter((r) => r.health === "offline").length,
    0,
  );
  const reposHeld = new Set(claims.flatMap((c) => c.repos.map((r) => `${c.serverId}::${r}`))).size;

  const counts: NavCounts = {
    claims: claims.length,
    myTickets: myClaims(claims, user, directory).length,
    repoOffline,
    reposHeld,
    skipped,
    unreadChats,
  };

  // Per-account rollup for the sidebar: how many of an account's environments
  // are free, and whether any of them is in trouble.
  const rollups: AccountRollup[] = accounts.map((account) => {
    const owned = environments.filter((e) => e.accountId === account.id);
    const statuses = owned.map((env) => displayStatus(env, claims));
    const worst: EnvStatus = statuses.includes("issue") ? "issue" : "free";

    return {
      id: account.id,
      displayName: account.displayName,
      free: statuses.filter((s) => s === "free").length,
      total: owned.length,
      worst,
    };
  });

  return (
    // Mounted here rather than in the root layout so it never exists on the
    // sign-in screen — there is no session to authorize a subscription with, and
    // a connection attempt there would only fail noisily.
    <PusherProvider userId={user.id}>
      {/* Inside PusherProvider, because it shares the one connection.
          Toaster wraps UnreadProvider, which calls useToast. */}
      <PresenceProvider canChat={roleCan(user.role, "chat")}>
        <Toaster>
          <UnreadProvider
            userId={user.id}
            initialTotal={unreadChats}
            canChat={roleCan(user.role, "chat")}
          >
            <div className="flex h-full">
              <Sidebar
                user={user}
                avatar_url={avatarUrl(user.id, avatars)}
                counts={counts}
                accounts={rollups}
              />

              <div className="flex min-w-0 flex-1 flex-col bg-panel">
                {/* useSearchParams needs a Suspense boundary above it. */}
                <Suspense fallback={<div className="h-14 shrink-0 border-b border-line bg-panel" />}>
                  <Topbar
                    jiraEnabled={settings.jira.enabled}
                    lastSyncAt={syncState.lastSyncAt}
                  />
                </Suspense>

                <main className="no-scrollbar min-h-0 flex-1 overflow-y-auto pt-5">{children}</main>
              </div>
            </div>
          </UnreadProvider>
        </Toaster>
      </PresenceProvider>
    </PusherProvider>
  );
}
