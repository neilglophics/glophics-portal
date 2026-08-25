/**
 * Domain types, shared by server and client.
 *
 * These describe the shapes the app passes around, which are the row shapes of
 * docs/02-DATA-MODEL.md mapped to camelCase. The `lib/db/queries/*` modules are
 * the only place that sees snake_case; everything above them uses these.
 */

// ---------- roles and capabilities ----------

export type Capability =
  | "view"
  | "claim"
  | "configure"
  | "manage-users"
  | "chat"
  /** Read the whole team's workload — /team. Superadmin only; see ADR-012. */
  | "oversee";
export type RoleId = "superadmin" | "admin" | "member" | "viewer";

// ---------- derived status ----------

/** Computed, never stored. See lib/shared/occupancy.ts. */
export type EnvStatus = "free" | "partial" | "inuse" | "issue";

export type RepoHealth = "online" | "offline" | "checking" | "unconfigured";

/**
 * How loaded one person is — derived from their claims and live Jira tickets,
 * never stored. See lib/shared/workload.ts.
 *
 *   free        nothing assigned that is still live
 *   assigned    live work, but holding no environment
 *   busy        holding at least one environment
 *   overloaded  holding OVERLOADED_AT or more
 */
export type Availability = "free" | "assigned" | "busy" | "overloaded";

// ---------- the two identity spaces ----------
// Kept as distinct branded-ish aliases because confusing them is the single
// most common source of bugs in this app. See CLAUDE.md.

/** Someone who can sign in. `auth_users.id`. */
export type AuthUserId = string;

/** Someone who can be assigned a claim. `directory_users.id`. Most of these
 *  have no login at all. */
export type DirectoryUserId = string;

export interface AuthUser {
  id: AuthUserId;
  username: string;
  displayName: string;
  role: RoleId;
  /** Null is normal and expected: an account may point at nobody. */
  directoryUserId: DirectoryUserId | null;
  /** Read *through* the directory link, never stored on the account — so fixing
   *  a typo in the directory fixes what "My tickets" shows, with no second edit. */
  jiraNames: string[];
  active: boolean;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

export interface DirectoryUser {
  id: DirectoryUserId;
  name: string;
  /** "Backend", "QA" — free text. NOT an auth role. */
  jobRole: string;
  jiraNames: string[];
  /** The active login pointing at this person, if any. A picture is uploaded by
   *  a login, so this is where a face is read from — the same "read through the
   *  link" rule jiraNames follows. Null for most of the board. */
  avatarUserId: AuthUserId | null;
}

// ---------- the board ----------

export interface Account {
  id: string;
  displayName: string;
  repositories: string[];
}

export interface ServerRepo {
  repoName: string;
  url: string;
  health: RepoHealth;
  healthCheckedAt: string | null;
  note: string | null;
}

export interface Environment {
  id: string;
  name: string;
  accountId: string;
  repos: ServerRepo[];
}

export type ClaimSource = "jira" | "manual";

export interface Claim {
  /** A Jira key ("PROJ-1234") or a generated "manual-…" id. */
  id: string;
  source: ClaimSource;
  serverId: string;
  accountName: string | null;
  branch: string | null;
  repos: string[];
  userIds: DirectoryUserId[];
  /** Jira labels that matched nobody. Kept verbatim so the board can show
   *  "assigned to a name we don't know" instead of silently showing nobody. */
  rawAssignees: string[];
  status: string;
  summary: string | null;
  note: string | null;
  startTime: string | null;
  endTime: string | null;
  claimedAt: string;
  lastSyncedAt: string | null;
  /** Jira's own creation/last-modified instants — null for a manual claim, or a
   *  Jira claim synced before this field existed. Powers the dashboard's
   *  New/Claimed/Updated badges; never used for occupancy. */
  jiraCreatedAt: string | null;
  jiraUpdatedAt: string | null;
}

export interface JiraIssue {
  key: string;
  serverId: string | null;
  accountName: string | null;
  branch: string | null;
  repos: string[];
  userIds: DirectoryUserId[];
  rawAssignees: string[];
  status: string;
  summary: string | null;
  startTime: string | null;
  endTime: string | null;
  jiraCreatedAt: string | null;
  jiraUpdatedAt: string | null;
}

export interface JiraSkipped {
  key: string;
  reason: string;
  status: string | null;
  accountName: string | null;
  branch: string | null;
}

// ---------- settings ----------

export type OnExpiry = "remind" | "remind-flag" | "auto-release";

export interface JiraSettings {
  enabled: boolean;
  requireTicket: boolean;
  pullTicketInfo: boolean;
  commentOnRelease: boolean;
  /** Reaching one of these claims the ticket's repositories. */
  occupyingStatuses: string[];
  /** Reaching one of these releases them. Any *other* status leaves an
   *  existing claim untouched — QA FAILED is still being worked on. */
  releasingStatuses: string[];
  /** Never asked for in bulk. The exception is a ticket already holding
   *  repositories, which is asked for by name whatever status it reached. */
  ignoredStatuses: string[];
  pollIntervalMinutes: number;
  autoSync: boolean;
}

export interface Settings {
  defaultBookingHours: number;
  onExpiry: OnExpiry;
  /** Claiming is per-repo, but most bookings take the whole environment. */
  assignWholeEnv: boolean;
  jira: JiraSettings;
}

// ---------- chat ----------

export type ConversationKind = "dm" | "group";
export type MessageKind = "text" | "system" | "attachment";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  createdBy: AuthUserId | null;
  createdAt: string;
  lastMessageAt: string | null;
}

export interface ChatMessage {
  /** Monotonic. This is the ordering key and the pagination cursor — never
   *  order chat by a client-supplied timestamp. */
  id: number;
  conversationId: string;
  senderId: AuthUserId | null;
  clientMsgId: string;
  body: string;
  kind: MessageKind;
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}
