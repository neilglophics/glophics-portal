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

  /**
   * Something arrived for this person.
   *
   * Carries enough to render a toast without a fetch — who sent it, a snippet,
   * and the title as THIS recipient sees it (for a DM that is the sender's name,
   * for a group the group's). `totalUnread` is the whole-app figure so the nav
   * badge can be set directly rather than recomputed.
   *
   * The snippet is message content on a per-user channel. That is the same
   * exposure `message.new` already carries and no worse — this channel is only
   * subscribable by its own user — but it is the same open question either way
   * (docs/06-OPEN-QUESTIONS.md Q7).
   */
  "unread.changed": {
    conversationId: string;
    conversationTitle: string;
    senderName: string | null;
    preview: string;
    /** Unread in this conversation. */
    unreadCount: number;
    /** Unread across every conversation — what the nav badge shows. */
    totalUnread: number;
  };
  "conversation.added": { conversationId: string };
  /** Signal only. Jira details are fetched from this app after authorization. */
  "jira.notification": Record<string, never>;

  /**
   * This person is no longer in a conversation — they left, or were removed.
   *
   * It has to be a per-user event rather than one on the conversation channel,
   * because by the time it is published they are not allowed on that channel any
   * more: /api/pusher/auth checks chat_members, the row is gone, and the
   * subscription is dead. Told here, their tab can drop the conversation from the
   * list and unsubscribe instead of sitting on a channel that has gone quiet for
   * reasons it cannot see.
   *
   * Carries an id and nothing else. Whether they were removed or left is already
   * a system message in a thread they can no longer read, and putting "removed by
   * Alex" on this channel would be telling them something the group said after
   * they left.
   */
  "conversation.removed": { conversationId: string };
}

// ---------- conversation (phases 8-10) ----------

export interface ConversationEvents {
  /**
   * A message arrived.
   *
   * Carries the whole row, including its attachments' METADATA and the quote of
   * whatever it replied to — but never any file bytes and never a blob URL. A
   * receiver renders the bubble complete, at the right height, without a fetch;
   * the images inside it load from `/api/chat/attachments/[id]`, which re-checks
   * membership per read.
   *
   * That split is the point. Sending metadata over Pusher is the same exposure the
   * body already is (docs/06-OPEN-QUESTIONS.md Q7) and no worse — a filename and a
   * size. Sending a blob URL would be materially different: it would put a
   * location for the bytes into a third party's infrastructure, and it is exactly
   * what keeping downloads behind a proxy exists to prevent.
   */
  "message.new": {
    id: number;
    conversationId: string;
    senderId: string | null;
    clientMsgId: string;
    body: string;
    kind: string;
    replyToId: number | null;
    replyTo: {
      id: number;
      senderName: string | null;
      preview: string;
      deleted: boolean;
      thumbnailAttachmentId: string | null;
      attachmentCount: number;
    } | null;
    attachments: {
      id: string;
      filename: string;
      mime: string;
      bytes: number;
      width: number | null;
      height: number | null;
    }[];
    createdAt: string;
  };
  "message.edited": { id: number; conversationId: string; body: string; editedAt: string };
  "message.deleted": { id: number; conversationId: string };

  /**
   * A reaction was added or removed.
   *
   * ── Why the whole group and not a delta ──
   *
   * `users` is the COMPLETE membership of this one emoji after the change, never
   * "+1 from Sem". A delta is not idempotent: a duplicate event, or one arriving
   * after the tab has already applied its own optimistic toggle, would count the
   * same tap twice — and there is no way for a client to tell those apart. A whole
   * group is order-independent and safe to apply as many times as it arrives,
   * which is what `mergeReactionGroup` relies on.
   *
   * This is the one place where events-are-signals is relaxed, deliberately and
   * within the same reasoning as `message.new`: refetching a page of messages to
   * learn that one pill went from 2 to 3 is a round trip for six bytes of truth.
   * The payload is small and bounded (one emoji, its reactors), and the channel is
   * already gated on membership — the same gate that lets `message.new` carry a
   * body at all.
   *
   * An empty `users` means the last reactor removed theirs and the pill goes.
   *
   * Names are carried so hover can say who without a lookup. That is no more
   * exposure than the member list this channel's subscribers already have.
   */
  "reaction.changed": {
    messageId: number;
    conversationId: string;
    emoji: string;
    users: { id: string; displayName: string }[];
  };

  /**
   * The group's name or photo changed. A SIGNAL — the client refetches.
   *
   * `title` rides along because it is one short string that the header can paint
   * immediately, and a rename that visibly lags behind the system message
   * announcing it looks broken. The avatar does not: it is bytes behind a
   * versioned URL, so `avatarVersion` is the cache key and the image loads itself.
   *
   * `avatarVersion` is null when the photo did not change — meaning "keep what
   * you have", not "there is no photo". Only an avatar change sends a version, so
   * a rename cannot make a group's picture blink out and back.
   */
  "conversation.updated": {
    conversationId: string;
    title: string | null;
    avatarVersion: string | null;
  };

  /**
   * Somebody joined, left, was removed, or changed tier.
   *
   * An id and nothing else, so the client refetches the member list — the strict
   * events-are-signals rule, and right here because the member list feeds
   * authorization decisions in the UI (who may remove whom). A pushed copy of it
   * is a copy that can be stale at exactly the moment somebody clicks.
   */
  "members.changed": { conversationId: string };
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
