/**
 * The realtime event vocabulary. Imported by BOTH the publisher and the
 * subscriber, so a renamed event breaks the build rather than the feature.
 *
 * Two rules this file encodes:
 *
 *   1. EVENTS ARE SIGNALS, NOT STATE TRANSFER. Payloads name what changed and
 *      the client refetches. The legacy design pushed the whole board on every
 *      change; doing that through Pusher would blow the payload cap (~10 KB),
 *      burn message quota on every cron tick, and re-leak everything to
 *      everyone. The one place this will be relaxed is chat message bodies,
 *      where latency does not tolerate a round trip — see
 *      docs/06-OPEN-QUESTIONS.md Q7, still open.
 *
 *   2. NO SECRETS, EVER. Nothing here carries a password hash, a session token,
 *      or the Jira API token. Every payload transits a third party.
 */

// ---------- board ----------

export interface BoardEvents {
  /** A claim was created. Named repos so a viewer can decide whether it cares. */
  "claim.created": { claimId: string; serverId: string; repos: string[] };
  "claim.released": { claimId: string; serverId: string };
  /** The Jira sync refreshed a held claim's status. */
  "claim.updated": { claimId: string; serverId: string; status: string };

  /**
   * A batch of health results, not one event per repository.
   *
   * The health pass touches every repo on every environment. One event each
   * would be dozens of messages per interval, which is how a message quota
   * disappears — so a pass coalesces into a single event.
   */
  "server.health": {
    checkedAt: string;
    changed: { serverId: string; repoName: string; health: string }[];
  };

  /** Time-based expiry released claims. A count, not one event per claim — a
   *  sweep can clear many at once and the client refetches regardless. */
  "claims.expired": { count: number };

  /** Shape-of-the-board changes. The payload is an id; the client refetches. */
  "server.changed": { serverId: string | null };
  "account.changed": { accountId: string | null };
  "directory.changed": { personId: string | null };
  /** A sign-in account was created, edited or removed. Carries an id and
   *  nothing else — never a username, role, or anything about the credential. */
  "login.changed": { userId: string | null };
  "note.changed": { serverId: string; repoName: string };
  "settings.changed": Record<string, never>;

  "jira.synced": {
    lastSyncAt: string;
    issueCount: number;
    claimed: number;
    released: number;
    skippedCount: number;
  };
}

// ---------- per-user ----------

export interface UserEvents {
  /**
   * This person's password, role or active flag changed, so every session they
   * held is gone.
   *
   * Closes a real gap: without this, a revoked session keeps rendering until its
   * tab happens to make a request. Publishing it makes revocation immediate and
   * visible, which is what the app documents.
   */
  "session.revoked": Record<string, never>;

  /** Phase 12. Declared now so the client contract is stable. */
  "unread.changed": { conversationId: string; unreadCount: number };
  "conversation.added": { conversationId: string };
}

// ---------- conversation (phases 8-10) ----------

export interface ConversationEvents {
  "message.new": {
    id: number;
    conversationId: string;
    senderId: string | null;
    clientMsgId: string;
    body: string;
    kind: string;
    replyToId: number | null;
    createdAt: string;
  };
  "message.edited": { id: number; conversationId: string; body: string; editedAt: string };
  "message.deleted": { id: number; conversationId: string };
  /** Never persisted, and there is no `typing.stop` — the receiver lets a
   *  ~4-second timer lapse. A stop event would double the volume of the noisiest
   *  event in the system to convey nothing a timeout cannot. */
  "typing.start": { conversationId: string; userId: string };
  "read.changed": { conversationId: string; userId: string; lastReadMessageId: number };
}

export type BoardEventName = keyof BoardEvents;
export type UserEventName = keyof UserEvents;
export type ConversationEventName = keyof ConversationEvents;

/** Every board event name, for the client to subscribe to in one loop. */
export const BOARD_EVENT_NAMES = [
  "claim.created",
  "claim.released",
  "claim.updated",
  "claims.expired",
  "server.health",
  "server.changed",
  "account.changed",
  "directory.changed",
  "login.changed",
  "note.changed",
  "settings.changed",
  "jira.synced",
] as const satisfies readonly BoardEventName[];
