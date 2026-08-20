import { Notice, Page, PageHead } from "@/components/ui/Layout";
import { AccountsCard } from "@/components/settings/AccountsCard";
import { BookingSettings } from "@/components/settings/BookingSettings";
import { EnvironmentsCard } from "@/components/settings/EnvironmentsCard";
import { JiraSettings } from "@/components/settings/JiraSettings";
import { requireUser } from "@/lib/auth/require";
import { getBoard, getJiraSyncState } from "@/lib/db/queries/board";
import { describeJiraConfig } from "@/lib/jira/client";

/**
 * Everything behind the `configure` capability: booking defaults, the Jira
 * integration and its status rules, accounts, and environments.
 *
 * People stay on the Users page rather than here, because that page is the join
 * between a directory person and their login — splitting it would mean editing
 * the same person in two places.
 */
export const metadata = { title: "Settings · Glophics Portal" };

export default async function SettingsPage() {
  await requireUser("configure");

  const [board, syncState] = await Promise.all([getBoard(), getJiraSyncState()]);
  const { accounts, environments, settings } = board;
  const connection = describeJiraConfig();

  const withoutUrls = environments.reduce(
    (n, env) => n + env.repos.filter((r) => !r.url).length,
    0,
  );

  return (
    <Page>
      <PageHead title="Settings" sub="Booking defaults, the Jira integration, accounts and environments" />

      {settings.jira.enabled && !connection.configured ? (
        <Notice tone="bad" title="Jira is switched on but not configured">
          No sync can run until <code className="font-mono">JIRA_BASE_URL</code>,{" "}
          <code className="font-mono">JIRA_EMAIL</code> and{" "}
          <code className="font-mono">JIRA_API_TOKEN</code> are set in the deployment. Until then the
          board is effectively manual.
        </Notice>
      ) : null}

      {withoutUrls ? (
        <Notice tone="warn" title={`${withoutUrls} repositories have no URL`}>
          They read as <strong>No URL set</strong> rather than offline, so they never make an
          environment look broken — but nothing checks them either.
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <BookingSettings settings={settings} />
          <AccountsCard accounts={accounts} environments={environments} />
          <EnvironmentsCard environments={environments} accounts={accounts} />
        </div>

        <JiraSettings
          jira={settings.jira}
          connection={connection}
          lastSyncAt={syncState.lastSyncAt}
          lastError={syncState.lastError}
        />
      </div>
    </Page>
  );
}
