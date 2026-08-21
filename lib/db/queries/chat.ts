/**
 * Chat reads and writes.
 *
 * ── The one rule ──
 *
 * MEMBERSHIP IS THE AUTHORIZATION BOUNDARY. Every function here either takes a
 * `viewerId` and filters by it, or calls `assertMember` first. There is no
 * function that reads messages without proving membership on the same call, and
 * none should be added: authorization lives in the application layer (ADR-008),
 * so a missing WHERE clause has no second net beneath it.
 *
 * A `superadmin` gets no implicit bypass. If admins are ever meant to read any
 * conversation that is a product decision (docs/06-OPEN-QUESTIONS.md Q5) and
 * belongs in an explicit, logged code path.
 *
 * ── Participants are auth_users ──
 *
 * Not directory people. You can only usefully chat with someone who can read it,
 * and most of the board has no login (ADR-007).
 */

import { sql, withTransaction } from "@/lib/db/client";
import type { PoolClient } from "@neondatabase/serverless";
import { HttpError } from "@/lib/auth/require";
import { MESSAGE_MAX_LENGTH, messageLength } from "@/lib/chat/limits";
import { isAllowedReaction, type ReactionGroup } from "@/lib/chat/reactions";
import {
  canManageGroup,
  canManageRoles,
  canRemoveMember,
  normalizeGroupName,
  successorTo,
  systemMessageBody,
  type MemberRole,
  type SystemEvent,
} from "@/lib/chat/groups";
import type { AuthUserId } from "@/lib/types";

// ---------- shapes ----------

export interface ConversationMember {
  id: AuthUserId;
  displayName: string;
  avatarUrl: string | null;
  /** Their standing inside THIS conversation, which has nothing to do with their
   *  board role. A viewer-role login cannot chat at all; a member-role login can
   *  own a group. */
  memberRole: MemberRole;
  joinedAt: string;
}

export interface ConversationSummary {
  id: string;
  kind: "dm" | "group";
  /** For a DM this is the other member's display name, resolved below. */
  title: string;
  /** A group's uploaded photo, or null. Always null for a DM, which renders the
   *  other person's face instead. */
  avatarUrl: string | null;
  createdAt: string;
  /** Bumped by a rename, an avatar change or a membership change — none of which
   *  are messages, so none of which touch `lastMessageAt`. */
  updatedAt: string;
  lastMessageAt: string | null;
  members: ConversationMember[];
  /** The viewer's own standing. Null would mean they are not a member, which
   *  cannot happen here — every row is joined through their membership. */
  viewerRole: MemberRole;
  unreadCount: number;
  lastMessagePreview: string | null;
  muted: boolean;
}

export interface MessageRow {
  id: number;
  conversationId: string;
  senderId: AuthUserId | null;
  senderName: string | null;
  clientMsgId: string;
  body: string;
  kind: string;
  /** Set only on `kind === "system"`. Names what happened, so the client can
   *  render it distinctly without parsing English out of `body`. */
  systemEvent: string | null;
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** One entry per emoji that has at least one reactor. Empty on a message
   *  nobody has reacted to, and on a deleted one. */
  reactions: ReactionGroup[];
}

// ---------- membership ----------

/**
 * Proves the viewer is in the conversation, or refuses.
 *
 * Deliberately 404 and not 403: a 403 confirms the conversation exists, which
 * tells a probing caller which ids are real. "Not found" is true from the
 * viewer's point of view either way.
 */
export async function assertMember(conversationId: string, viewerId: AuthUserId): Promise<void> {
  const rows = (await sql`
    SELECT 1 FROM chat_members
     WHERE conversation_id = ${conversationId} AND user_id = ${viewerId}
     LIMIT 1
  `) as unknown[];

  if (!rows.length) throw new HttpError(404, "No such conversation.");
}

export async function memberIds(conversationId: string): Promise<AuthUserId[]> {
  const rows = (await sql`
    SELECT user_id FROM chat_members WHERE conversation_id = ${conversationId}
  `) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/**
 * The viewer's standing in a group, or a 404.
 *
 * Returns the kind alongside the role so every caller can refuse a group
 * operation aimed at a DM in one place rather than each remembering to. A DM has
 * no owner and no admins — renaming one, or adding a third person to it, is not
 * a permission question but a category error, and it must not silently half-work.
 */
async function requireGroupRole(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<{ role: MemberRole; title: string | null }> {
  const rows = (await sql`
    SELECT m.member_role, c.kind, c.title
      FROM chat_members m
      JOIN chat_conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ${conversationId} AND m.user_id = ${viewerId}
     LIMIT 1
  `) as { member_role: MemberRole; kind: "dm" | "group"; title: string | null }[];

  const row = rows[0];
  // Same 404 as assertMember, and for the same reason: a 403 would confirm the
  // id is real to somebody guessing them.
  if (!row) throw new HttpError(404, "No such conversation.");
  if (row.kind !== "group") throw new HttpError(400, "That's a direct message, not a group.");

  return { role: row.member_role, title: row.title };
}

/** Every member with their role and seniority — what the succession and the
 *  permission checks both need. */
async function groupMembers(
  conversationId: string,
): Promise<{ userId: AuthUserId; role: MemberRole; joinedAt: string; displayName: string }[]> {
  const rows = (await sql`
    SELECT m.user_id, m.member_role, m.joined_at, u.display_name
      FROM chat_members m
      JOIN auth_users u ON u.id = m.user_id
     WHERE m.conversation_id = ${conversationId}
     ORDER BY m.joined_at, u.display_name
  `) as { user_id: string; member_role: MemberRole; joined_at: string; display_name: string }[];

  return rows.map((r) => ({
    userId: r.user_id,
    role: r.member_role,
    joinedAt: r.joined_at,
    displayName: r.display_name,
  }));
}

/** The URL a group's photo is served from, or null. Built here rather than in
 *  SQL — the shape of a URL is application code's business. */
function groupAvatarUrl(conversationId: string, version: string | null): string | null {
  return version
    ? `/api/chat/conversations/${conversationId}/avatar?v=${encodeURIComponent(version)}`
    : null;
}

// ---------- conversations ----------

/**
 * A DM's identity is its pair of participants, sorted.
 *
 * Sorting is what makes it symmetric: A→B and B→A produce the same key, so the
 * unique index refuses the second one. Without it two people opening a DM with
 * each other at the same moment would create two conversations and each would
 * see half the messages.
 */
export function dmKey(a: AuthUserId, b: AuthUserId): string {
  return [a, b].sort().join(":");
}

/** Every conversation the viewer is in, most recently active first. */
export async function listConversations(viewerId: AuthUserId): Promise<ConversationSummary[]> {
  const rows = (await sql`
    SELECT c.id, c.kind, c.title, c.created_at, c.updated_at, c.last_message_at,
           me.muted, me.last_read_message_id, me.member_role AS viewer_role,
           ca.updated_at AS avatar_version,
           -- Unread is DERIVED from the watermark, never stored as a column that
           -- could drift out of step with the messages themselves (ADR-006).
           (SELECT count(*)::int FROM chat_messages m
             WHERE m.conversation_id = c.id
               AND m.deleted_at IS NULL
               AND m.id > COALESCE(me.last_read_message_id, 0)
               AND m.sender_id IS DISTINCT FROM ${viewerId}) AS unread_count,
           (SELECT m.body FROM chat_messages m
             WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
             ORDER BY m.id DESC LIMIT 1) AS last_preview,
           COALESCE(
             (SELECT json_agg(json_build_object(
                        'id', u.id,
                        'displayName', u.display_name,
                        'memberRole', mm.member_role,
                        'joinedAt', mm.joined_at,
                        -- The version, not a URL: the shape of the URL belongs in
                        -- application code, not in SQL.
                        'avatarVersion', av.updated_at)
                              ORDER BY u.display_name)
                FROM chat_members mm
                JOIN auth_users u ON u.id = mm.user_id
                LEFT JOIN auth_user_avatars av ON av.user_id = u.id
               WHERE mm.conversation_id = c.id),
             '[]'::json
           ) AS members
      FROM chat_conversations c
      JOIN chat_members me ON me.conversation_id = c.id AND me.user_id = ${viewerId}
      LEFT JOIN chat_conversation_avatars ca ON ca.conversation_id = c.id
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  `) as {
    id: string;
    kind: "dm" | "group";
    title: string | null;
    created_at: string;
    updated_at: string;
    last_message_at: string | null;
    muted: boolean;
    viewer_role: MemberRole;
    avatar_version: string | null;
    unread_count: number;
    last_preview: string | null;
    members: {
      id: string;
      displayName: string;
      memberRole: MemberRole;
      joinedAt: string;
      avatarVersion: string | null;
    }[];
  }[];

  return rows.map((r) => {
    const members: ConversationMember[] = (r.members ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      memberRole: m.memberRole,
      joinedAt: m.joinedAt,
      avatarUrl: m.avatarVersion
        ? `/api/avatar/${m.id}?v=${encodeURIComponent(m.avatarVersion)}`
        : null,
    }));
    // A DM has no stored title — it *is* the other person. Falls back to the
    // viewer's own name for a self-DM, and to "Conversation" if the other member
    // has been removed.
    const other = members.find((m) => m.id !== viewerId) ?? members[0];
    const title = r.kind === "group" ? (r.title ?? "Group") : (other?.displayName ?? "Conversation");

    return {
      id: r.id,
      kind: r.kind,
      title,
      // Only a group has one of its own. A DM's picture is a person's face,
      // which the caller already has on the member row.
      avatarUrl: r.kind === "group" ? groupAvatarUrl(r.id, r.avatar_version) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessageAt: r.last_message_at,
      members,
      viewerRole: r.viewer_role,
      unreadCount: r.unread_count,
      lastMessagePreview: r.last_preview,
      muted: r.muted,
    };
  });
}

/**
 * Opens the DM between two people, creating it only if it does not exist.
 *
 * The race is handled by the database, not by checking first: two simultaneous
 * calls both try to insert, one wins the unique index on dm_key, and the loser
 * re-reads the winner's row. Checking-then-inserting would leave a window where
 * both checks pass.
 */
export async function openDirectMessage(
  viewerId: AuthUserId,
  otherUserId: AuthUserId,
): Promise<{ id: string; created: boolean }> {
  if (viewerId === otherUserId) {
    throw new HttpError(400, "You can't start a conversation with yourself.");
  }

  const exists = (await sql`
    SELECT 1 FROM auth_users WHERE id = ${otherUserId} AND active = true LIMIT 1
  `) as unknown[];
  if (!exists.length) throw new HttpError(404, "That person has no active login.");

  const key = dmKey(viewerId, otherUserId);

  const found = (await sql`
    SELECT id FROM chat_conversations WHERE dm_key = ${key}
  `) as { id: string }[];
  if (found[0]) return { id: found[0].id, created: false };

  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO chat_conversations (kind, dm_key, created_by) VALUES ('dm', $1, $2)
         RETURNING id`,
        [key, viewerId],
      );
      const id = inserted.rows[0]!.id;

      for (const userId of [viewerId, otherUserId]) {
        await client.query(
          "INSERT INTO chat_members (conversation_id, user_id, member_role) VALUES ($1, $2, 'member')",
          [id, userId],
        );
      }
      return { id, created: true };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // Lost the race. The winner's row is the answer.
      const raced = (await sql`SELECT id FROM chat_conversations WHERE dm_key = ${key}`) as {
        id: string;
      }[];
      if (raced[0]) return { id: raced[0].id, created: false };
    }
    throw err;
  }
}

/** Creates a group conversation with the viewer as owner. */
export async function createGroup(
  viewerId: AuthUserId,
  title: string,
  memberIdsIn: AuthUserId[],
): Promise<{ id: string; members: AuthUserId[] }> {
  const named = normalizeGroupName(title);
  if (!named.ok) throw new HttpError(400, named.error);
  const name = named.name;

  // The creator is always a member, and duplicates in the payload are collapsed.
  const wanted = [...new Set([viewerId, ...memberIdsIn])];

  const valid = (await sql`
    SELECT id, display_name FROM auth_users
     WHERE id = ANY(${wanted}::uuid[]) AND active = true
  `) as { id: string; display_name: string }[];
  const members = valid.map((r) => r.id);

  if (members.length < 2) throw new HttpError(400, "A group needs at least one other person.");

  const actorName = valid.find((r) => r.id === viewerId)?.display_name ?? "Someone";

  const id = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO chat_conversations (kind, title, created_by) VALUES ('group', $1, $2) RETURNING id",
      [name, viewerId],
    );
    const conversationId = inserted.rows[0]!.id;

    for (const userId of members) {
      await client.query(
        "INSERT INTO chat_members (conversation_id, user_id, member_role) VALUES ($1, $2, $3)",
        [conversationId, userId, userId === viewerId ? "owner" : "member"],
      );
    }

    // So the thread opens with something in it rather than "No messages yet" on
    // a group that demonstrably exists — and so the list preview says who made
    // it. Inside the transaction: a group whose creation was not recorded is
    // the same bug as a group with no members.
    await writeSystemMessage(client, conversationId, viewerId, "group.created", actorName);

    return conversationId;
  });

  return { id, members };
}

/**
 * One conversation, in full, for the header and the manage-group dialog.
 *
 * Reads through `listConversations` rather than by id, exactly as the page does,
 * because that query is already filtered by membership — so there is no separate
 * authorization step here to forget. It costs one extra query's worth of rows for
 * a list that is a handful long.
 */
export async function conversationDetail(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<ConversationSummary> {
  const found = (await listConversations(viewerId)).find((c) => c.id === conversationId);
  if (!found) throw new HttpError(404, "No such conversation.");
  return found;
}

// ---------- messages ----------

const PAGE_SIZE = 50;

/**
 * A page of messages, newest first.
 *
 * Keyset pagination on the bigserial id, not OFFSET. `WHERE id < cursor` is exact
 * and stable: a message arriving mid-scroll cannot shift a page boundary and make
 * a row appear twice or not at all, which is precisely what OFFSET does.
 *
 * `after` is the catch-up direction — everything newer than what the client has
 * already rendered, used on reconnect because Pusher does not replay.
 */
export async function listMessages(
  conversationId: string,
  viewerId: AuthUserId,
  opts: { before?: number; after?: number; limit?: number } = {},
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  await assertMember(conversationId, viewerId);

  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);

  const rows = (await sql`
    SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_name,
           m.client_msg_id, m.body, m.kind, m.system_event, m.reply_to_id,
           m.created_at, m.edited_at, m.deleted_at,
           -- Reactions come back WITH the page rather than from a second request.
           --
           -- A separate round trip per page would double the requests a thread
           -- makes and open a window where a message renders without the
           -- reactions it already has — visible as pills popping in a moment
           -- late. One join, and the page is complete when it arrives.
           --
           -- Grouped by emoji here rather than in TypeScript because the shape
           -- the client wants IS the grouped shape; assembling it from flat rows
           -- would be the same work done twice, once per page and once per
           -- event.
           COALESCE((
             SELECT json_agg(json_build_object('emoji', g.emoji, 'users', g.users)
                             -- Pills are ordered by when the emoji FIRST
                             -- appeared, so an existing pill never jumps
                             -- position because somebody piled on. A row that
                             -- reshuffles under the cursor cannot be clicked
                             -- twice in a row.
                             ORDER BY g.first_at)
               FROM (
                 SELECT r.emoji,
                        min(r.created_at) AS first_at,
                        json_agg(json_build_object('id', ru.id, 'displayName', ru.display_name)
                                 ORDER BY r.created_at) AS users
                   FROM chat_message_reactions r
                   JOIN auth_users ru ON ru.id = r.user_id
                  WHERE r.message_id = m.id
                  GROUP BY r.emoji
               ) g
           ), '[]'::json) AS reactions
      FROM chat_messages m
      LEFT JOIN auth_users u ON u.id = m.sender_id
     WHERE m.conversation_id = ${conversationId}
       AND (${opts.before ?? null}::bigint IS NULL OR m.id < ${opts.before ?? null}::bigint)
       AND (${opts.after ?? null}::bigint IS NULL OR m.id > ${opts.after ?? null}::bigint)
     ORDER BY m.id DESC
     LIMIT ${limit + 1}
  `) as {
    id: string | number;
    conversation_id: string;
    sender_id: string | null;
    sender_name: string | null;
    client_msg_id: string;
    body: string;
    kind: string;
    system_event: string | null;
    reply_to_id: string | number | null;
    created_at: string;
    edited_at: string | null;
    deleted_at: string | null;
    reactions: ReactionGroup[] | null;
  }[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    // bigint arrives as a string from the driver — coerced here so the client
    // never has to guess whether an id is a number or a string.
    messages: page.map((r) => ({
      id: Number(r.id),
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      clientMsgId: r.client_msg_id,
      // A soft-deleted message keeps its slot so replies and ordering survive,
      // but its text must not be served.
      body: r.deleted_at ? "" : r.body,
      kind: r.kind,
      systemEvent: r.system_event,
      replyToId: r.reply_to_id === null ? null : Number(r.reply_to_id),
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
      // deleteMessage() already removes the rows, so this is a second net
      // rather than the mechanism — but a reaction pill hanging under "Message
      // deleted" would be a strange thing to have to explain, and belt and
      // braces costs one comparison.
      reactions: r.deleted_at ? [] : (r.reactions ?? []),
    })),
    hasMore,
  };
}

export interface SendResult {
  message: MessageRow;
  /** False when this was a duplicate of a message already stored — a retry. */
  created: boolean;
  /** Everyone who should be told, excluding the sender. */
  notify: AuthUserId[];
}



/**
 * Sends a message.
 *
 * One transaction doing three things that must not half-apply: insert the
 * message, bump the conversation's activity time, and advance the sender's own
 * read watermark (you have read what you just wrote).
 *
 * `ON CONFLICT (conversation_id, client_msg_id) DO NOTHING` makes a retry
 * idempotent. A dropped response on a flaky connection is the normal case here,
 * not an edge case — without this, every such retry double-posts.
 */
export async function sendMessage(
  conversationId: string,
  viewerId: AuthUserId,
  input: { clientMsgId: string; body: string; replyToId?: number | null },
): Promise<SendResult> {
  await assertMember(conversationId, viewerId);

  const body = input.body.trim();
  if (!body) throw new HttpError(400, "Nothing to send.");

  // Counted in graphemes, exactly as the composer counts it, so a message the UI
  // said was 2000 is never rejected here as 2004 because of a few emoji.
  const length = messageLength(body);
  if (length > MESSAGE_MAX_LENGTH) {
    throw new HttpError(
      400,
      `That message is ${length} characters. The limit is ${MESSAGE_MAX_LENGTH}.`,
    );
  }

  const clientMsgId = String(input.clientMsgId ?? "").trim();
  if (!clientMsgId || clientMsgId.length > 100) {
    throw new HttpError(400, "Bad client message id.");
  }

  const outcome = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO chat_messages (conversation_id, sender_id, client_msg_id, body, kind, reply_to_id)
       VALUES ($1, $2, $3, $4, 'text', $5)
       ON CONFLICT (conversation_id, client_msg_id) DO NOTHING
       RETURNING id, created_at`,
      [conversationId, viewerId, clientMsgId, body, input.replyToId ?? null],
    );

    if (!inserted.rows.length) {
      // A retry. Return what is already stored rather than erroring — from the
      // caller's point of view the send succeeded, which it did.
      const existing = await client.query<{ id: string; created_at: string }>(
        "SELECT id, created_at FROM chat_messages WHERE conversation_id = $1 AND client_msg_id = $2",
        [conversationId, clientMsgId],
      );
      return { row: existing.rows[0]!, created: false };
    }

    const row = inserted.rows[0]!;

    await client.query(
      "UPDATE chat_conversations SET last_message_at = $2 WHERE id = $1",
      [conversationId, row.created_at],
    );
    await client.query(
      `UPDATE chat_members SET last_read_message_id = $3, last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, viewerId, row.id],
    );

    return { row, created: true };
  });

  const senderName = (await sql`
    SELECT display_name FROM auth_users WHERE id = ${viewerId}
  `) as { display_name: string }[];

  const everyone = await memberIds(conversationId);

  return {
    created: outcome.created,
    notify: everyone.filter((id) => id !== viewerId),
    message: {
      id: Number(outcome.row.id),
      conversationId,
      senderId: viewerId,
      senderName: senderName[0]?.display_name ?? null,
      clientMsgId,
      body,
      kind: "text",
      systemEvent: null,
      replyToId: input.replyToId ?? null,
      createdAt: outcome.row.created_at,
      editedAt: null,
      deletedAt: null,
      // A message nobody has seen yet cannot have been reacted to. Stated
      // rather than omitted so the event payload and a fetched page are the
      // same shape — the client merges them through the same function.
      reactions: [],
    },
  };
}

// ---------- deleting ----------

/**
 * Soft-deletes a message, and hard-deletes its reactions.
 *
 * ── Soft for the message, hard for the reactions ──
 *
 * The message keeps its row so replies still point somewhere, the read watermark
 * still means what it meant, and keyset pagination does not develop a hole. Its
 * text is what actually goes: `listMessages` serves an empty body for a deleted
 * row, so the content is unreachable through the API even though the row is
 * still there.
 *
 * The reactions get no such treatment. They are deleted outright, in the same
 * transaction, because:
 *
 *   - "😂 3" sitting under "Message deleted" is a count of laughs at something
 *     nobody can read, which is worse than nothing.
 *   - A reaction is a fact about content. Once the content is withdrawn the fact
 *     no longer has a referent, and keeping it would leave the reactors
 *     attributable to a message that has been retracted.
 *   - There is nothing to preserve ordering FOR — nothing references a reaction.
 *
 * The database would also cascade these away if the row were ever hard-deleted
 * (see the FK in migration 0004). This is the soft path doing deliberately what
 * the hard path gets for free.
 *
 * Only the sender may delete their own message, and there is no admin override:
 * a group admin who could silently remove other people's words is a different
 * product with a different set of promises. The system messages are not
 * deletable at all — they are the group's audit trail.
 */
export async function deleteMessage(
  conversationId: string,
  messageId: number,
  viewerId: AuthUserId,
): Promise<{ id: number; alreadyDeleted: boolean }> {
  await assertMember(conversationId, viewerId);

  const found = (await sql`
    SELECT sender_id, kind, deleted_at FROM chat_messages
     WHERE id = ${messageId} AND conversation_id = ${conversationId}
  `) as { sender_id: string | null; kind: string; deleted_at: string | null }[];

  const row = found[0];
  if (!row) throw new HttpError(404, "No such message.");
  if (row.kind === "system") throw new HttpError(403, "System messages can't be deleted.");
  if (row.sender_id !== viewerId) throw new HttpError(403, "You can only delete your own messages.");

  // Idempotent: deleting twice is a success, not a 404. A retry after a dropped
  // response is the normal case, exactly as it is for sending.
  if (row.deleted_at) return { id: messageId, alreadyDeleted: true };

  await withTransaction(async (client) => {
    await client.query(
      "UPDATE chat_messages SET deleted_at = now(), body = '' WHERE id = $1 AND deleted_at IS NULL",
      [messageId],
    );
    await client.query("DELETE FROM chat_message_reactions WHERE message_id = $1", [messageId]);
  });

  return { id: messageId, alreadyDeleted: false };
}

// ---------- reactions ----------

/**
 * The reactions on one message, grouped by emoji.
 *
 * Read back after every toggle so the event carries server truth rather than the
 * acting client's guess. Whole groups, never deltas — see the note on
 * `mergeReactionGroup` in lib/chat/reactions.ts.
 */
export async function reactionsFor(messageId: number): Promise<ReactionGroup[]> {
  const rows = (await sql`
    SELECT r.emoji,
           min(r.created_at) AS first_at,
           json_agg(json_build_object('id', u.id, 'displayName', u.display_name)
                    ORDER BY r.created_at) AS users
      FROM chat_message_reactions r
      JOIN auth_users u ON u.id = r.user_id
     WHERE r.message_id = ${messageId}
     GROUP BY r.emoji
     ORDER BY min(r.created_at)
  `) as { emoji: string; users: { id: string; displayName: string }[] }[];

  return rows.map((r) => ({ emoji: r.emoji, users: r.users }));
}

/**
 * Adds the viewer's reaction, or takes it away if it is already there.
 *
 * ── Why the toggle is one statement ──
 *
 * `DELETE … RETURNING` tells us whether a row was there, in the same statement
 * that removes it. If nothing came back, nothing was there, so we insert. Two
 * simultaneous taps therefore cannot both decide "not present yet" and both
 * insert — one of them deletes what the other wrote, which is the correct
 * outcome for a toggle pressed twice, and in no case is a duplicate created:
 * the primary key on (message_id, user_id, emoji) refuses that outright.
 *
 * `ON CONFLICT DO NOTHING` on the insert covers the mirror-image race, where two
 * taps both find nothing and both try to add.
 *
 * Returns the emoji's complete membership afterwards, which is what goes out over
 * Pusher — idempotent, so a duplicate event or one racing the sender's own
 * optimistic update lands on the same answer.
 */
export async function toggleReaction(
  conversationId: string,
  messageId: number,
  viewerId: AuthUserId,
  emoji: string,
): Promise<{ emoji: string; added: boolean; group: ReactionGroup }> {
  await assertMember(conversationId, viewerId);

  // The allowlist is enforced HERE, not only in the picker. Six emoji in a
  // dropdown is what the UI offers; this is what the app accepts.
  if (!isAllowedReaction(emoji)) throw new HttpError(400, "That's not a reaction we support.");

  // Scoped to the conversation, so a member of conversation A cannot react to a
  // message in conversation B by knowing its id — the membership check above is
  // about A, and without this clause the write would not be.
  const target = (await sql`
    SELECT id, deleted_at FROM chat_messages
     WHERE id = ${messageId} AND conversation_id = ${conversationId}
  `) as { id: string | number; deleted_at: string | null }[];

  const row = target[0];
  if (!row) throw new HttpError(404, "No such message.");
  // Reacting to something you cannot read is not a thing, and it would resurrect
  // rows that deleteMessage just cleared.
  if (row.deleted_at) throw new HttpError(409, "That message was deleted.");

  const removed = (await sql`
    DELETE FROM chat_message_reactions
     WHERE message_id = ${messageId} AND user_id = ${viewerId} AND emoji = ${emoji}
    RETURNING emoji
  `) as unknown[];

  const added = removed.length === 0;

  if (added) {
    await sql`
      INSERT INTO chat_message_reactions (message_id, user_id, emoji)
      VALUES (${messageId}, ${viewerId}, ${emoji})
      ON CONFLICT (message_id, user_id, emoji) DO NOTHING
    `;
  }

  const groups = await reactionsFor(messageId);

  return {
    emoji,
    added,
    // An empty group is the correct payload when the last reactor left: the
    // client drops the pill on seeing it. Fabricating one here rather than
    // omitting it keeps every event the same shape.
    group: groups.find((g) => g.emoji === emoji) ?? { emoji, users: [] },
  };
}

/**
 * Advances the viewer's read watermark.
 *
 * `GREATEST` so it can only ever move forward. Two tabs reporting different
 * positions must not let the lower one un-read messages the higher one saw.
 */
export async function markRead(
  conversationId: string,
  viewerId: AuthUserId,
  lastReadMessageId: number,
): Promise<{ lastReadMessageId: number }> {
  await assertMember(conversationId, viewerId);

  const rows = (await sql`
    UPDATE chat_members
       SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), ${lastReadMessageId}),
           last_read_at = now()
     WHERE conversation_id = ${conversationId} AND user_id = ${viewerId}
     RETURNING last_read_message_id
  `) as { last_read_message_id: string | number }[];

  return { lastReadMessageId: Number(rows[0]?.last_read_message_id ?? 0) };
}

/**
 * Each member's read position, keyed by user id.
 *
 * Seeds the thread so read state is right on first paint rather than only after
 * the next read.changed event — which for a conversation nobody is actively
 * looking at would be never.
 */
export async function conversationReadState(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<Record<string, number>> {
  await assertMember(conversationId, viewerId);

  const rows = (await sql`
    SELECT user_id, COALESCE(last_read_message_id, 0) AS last_read
      FROM chat_members WHERE conversation_id = ${conversationId}
  `) as { user_id: string; last_read: string | number }[];

  return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.last_read)]));
}

/**
 * Unread in one conversation, for one person.
 *
 * Separate from totalUnread because a toast wants both: "3 in this thread" and
 * "7 altogether". Computing the first from the second is not possible.
 */
export async function conversationUnread(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n
      FROM chat_messages m
      JOIN chat_members me
        ON me.conversation_id = m.conversation_id AND me.user_id = ${viewerId}
     WHERE m.conversation_id = ${conversationId}
       AND m.deleted_at IS NULL
       AND m.sender_id IS DISTINCT FROM ${viewerId}
       AND m.id > COALESCE(me.last_read_message_id, 0)
  `) as { n: number }[];

  return rows[0]?.n ?? 0;
}

/**
 * The bare facts a notification needs about a conversation, and who is muted.
 *
 * Muted members are excluded here rather than filtered later, so a muted
 * conversation costs no Pusher message at all — quota is the reason mute exists
 * to be honoured on the server side.
 */
export async function notificationTargets(
  conversationId: string,
  senderId: AuthUserId,
): Promise<{ kind: "dm" | "group"; title: string | null; recipients: AuthUserId[] }> {
  const rows = (await sql`
    SELECT c.kind, c.title,
           COALESCE(
             array_agg(m.user_id) FILTER (WHERE m.user_id <> ${senderId} AND m.muted = false),
             '{}'
           ) AS recipients
      FROM chat_conversations c
      JOIN chat_members m ON m.conversation_id = c.id
     WHERE c.id = ${conversationId}
     GROUP BY c.kind, c.title
  `) as { kind: "dm" | "group"; title: string | null; recipients: string[] }[];

  const row = rows[0];
  return {
    kind: row?.kind ?? "dm",
    title: row?.title ?? null,
    recipients: row?.recipients ?? [],
  };
}

/** Total unread across every conversation, for the nav badge. */
export async function totalUnread(viewerId: AuthUserId): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n
      FROM chat_messages m
      JOIN chat_members me
        ON me.conversation_id = m.conversation_id AND me.user_id = ${viewerId}
     WHERE m.deleted_at IS NULL
       AND m.sender_id IS DISTINCT FROM ${viewerId}
       AND m.id > COALESCE(me.last_read_message_id, 0)
       AND me.muted = false
  `) as { n: number }[];

  return rows[0]?.n ?? 0;
}

/** Everyone with a login who could be messaged. Excludes the viewer. */
export async function messageableUsers(
  viewerId: AuthUserId,
): Promise<
  { id: string; displayName: string; username: string; role: string; avatarUrl: string | null }[]
> {
  const rows = (await sql`
    SELECT u.id, u.display_name, u.username, u.role, av.updated_at AS avatar_version
      FROM auth_users u
      LEFT JOIN auth_user_avatars av ON av.user_id = u.id
     WHERE u.active = true AND u.id <> ${viewerId}
     ORDER BY u.display_name
  `) as {
    id: string;
    display_name: string;
    username: string;
    role: string;
    avatar_version: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    username: r.username,
    role: r.role,
    avatarUrl: r.avatar_version
      ? `/api/avatar/${r.id}?v=${encodeURIComponent(r.avatar_version)}`
      : null,
  }));
}

// ---------- system messages ----------

/**
 * Writes "Alex added Jamie" into the thread.
 *
 * Takes a transaction client rather than using `sql` directly, because it is
 * never the whole of what happened: the membership change and the line recording
 * it must land together or not at all. A group that gained a member with no note
 * of who added them is a group whose history lies.
 *
 * `client_msg_id` is generated here. The column is NOT NULL with a unique index
 * because it is how a retried send de-duplicates; a system message has no
 * retrying browser behind it, so a fresh uuid satisfies the index and means
 * nothing more than that.
 */
async function writeSystemMessage(
  client: PoolClient,
  conversationId: string,
  actorId: AuthUserId,
  event: SystemEvent,
  actorName: string,
  detail?: { targetName?: string; groupName?: string; role?: MemberRole },
): Promise<MessageRow> {
  const body = systemMessageBody(event, actorName, detail);

  const inserted = await client.query<{ id: string; created_at: string; client_msg_id: string }>(
    `INSERT INTO chat_messages (conversation_id, sender_id, client_msg_id, body, kind, system_event)
     VALUES ($1, $2, gen_random_uuid()::text, $3, 'system', $4)
     RETURNING id, created_at, client_msg_id`,
    [conversationId, actorId, body, event],
  );
  const row = inserted.rows[0]!;

  // A system message IS activity: it bumps the conversation up the list and
  // becomes its preview, which is how somebody finds out they were added to a
  // group without having to be told separately.
  await client.query("UPDATE chat_conversations SET last_message_at = $2 WHERE id = $1", [
    conversationId,
    row.created_at,
  ]);

  return {
    id: Number(row.id),
    conversationId,
    senderId: actorId,
    senderName: actorName,
    clientMsgId: row.client_msg_id,
    body,
    kind: "system",
    systemEvent: event,
    replyToId: null,
    createdAt: row.created_at,
    editedAt: null,
    deletedAt: null,
    reactions: [],
  };
}

/** `updated_at` is the group's own clock — a rename or a membership change is not
 *  a message, so it must not pretend to be one by moving `last_message_at`. This
 *  moves both, because the system message written alongside it is a message. */
async function touchGroup(client: PoolClient, conversationId: string): Promise<void> {
  await client.query("UPDATE chat_conversations SET updated_at = now() WHERE id = $1", [
    conversationId,
  ]);
}

/** The name to bake into a system message. Read inside the same call rather than
 *  taken from a caller's parameter, so it cannot be spoofed by a request body. */
async function displayNameOf(userId: AuthUserId): Promise<string> {
  const rows = (await sql`
    SELECT display_name FROM auth_users WHERE id = ${userId}
  `) as { display_name: string }[];
  return rows[0]?.display_name ?? "Someone";
}

// ---------- group management ----------

/**
 * What every group mutation hands back.
 *
 * `systemMessage` so the route can publish it as an ordinary `message.new` — the
 * thread then renders the line through the same path as any other message, with
 * no second code path to keep in step. `members` is who should now be told
 * anything at all about this conversation, which after a removal is a different
 * set from who was told before it.
 */
export interface GroupChangeResult {
  systemMessage: MessageRow;
  members: AuthUserId[];
  /** Left the group, or was removed. Their client must drop the conversation and
   *  unsubscribe, which no event on the conversation channel could tell them —
   *  they are no longer allowed on it. */
  departedUserId?: AuthUserId;
}

/** Renames a group. Owners and admins. */
export async function renameGroup(
  conversationId: string,
  viewerId: AuthUserId,
  title: string,
): Promise<GroupChangeResult & { title: string }> {
  const { role, title: current } = await requireGroupRole(conversationId, viewerId);
  if (!canManageGroup(role)) {
    throw new HttpError(403, "Only the owner or an admin can rename this group.");
  }

  const named = normalizeGroupName(title);
  if (!named.ok) throw new HttpError(400, named.error);

  // A "rename" to the name it already has writes nothing and, more to the point,
  // does not put a system message in the thread claiming something changed.
  if (named.name === current) throw new HttpError(409, "That's already the group's name.");

  const actorName = await displayNameOf(viewerId);

  const systemMessage = await withTransaction(async (client) => {
    await client.query(
      "UPDATE chat_conversations SET title = $2, updated_at = now() WHERE id = $1",
      [conversationId, named.name],
    );
    return writeSystemMessage(client, conversationId, viewerId, "group.renamed", actorName, {
      groupName: named.name,
    });
  });

  return { systemMessage, members: await memberIds(conversationId), title: named.name };
}

/**
 * Refuses unless the viewer may administer this group.
 *
 * Exported so a route can check the permission BEFORE doing expensive work — the
 * avatar upload wants to turn away a plain member without first sending their
 * file to the optimiser on their behalf.
 */
export async function assertCanManageGroup(
  conversationId: string,
  viewerId: AuthUserId,
  what = "do that",
): Promise<void> {
  const { role } = await requireGroupRole(conversationId, viewerId);
  if (!canManageGroup(role)) {
    throw new HttpError(403, `Only the owner or an admin can ${what}.`);
  }
}

/**
 * Records that the group photo changed.
 *
 * The bytes are written by the avatar route (they go in their own table, exactly
 * as a person's do); this is only the part that belongs to the conversation — the
 * timestamp, and the line in the thread. Separated because the upload can fail at
 * the optimiser, and a system message announcing a photo that was never stored
 * would be a claim the group has no way to correct.
 */
export async function recordGroupAvatarChange(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<GroupChangeResult> {
  const { role } = await requireGroupRole(conversationId, viewerId);
  if (!canManageGroup(role)) {
    throw new HttpError(403, "Only the owner or an admin can change the group photo.");
  }

  const actorName = await displayNameOf(viewerId);

  const systemMessage = await withTransaction(async (client) => {
    await touchGroup(client, conversationId);
    return writeSystemMessage(client, conversationId, viewerId, "group.avatar", actorName);
  });

  return { systemMessage, members: await memberIds(conversationId) };
}

/**
 * Adds people to a group.
 *
 * ── One system message per person, not one for the batch ──
 *
 * "Alex added Jamie and 3 others" reads fine and is useless six months later,
 * when the question is when a specific person gained access to a specific
 * conversation. Three lines answer that; one summary does not.
 *
 * Ids already in the group are skipped rather than rejected. Adding somebody
 * twice is the sort of thing two admins do simultaneously, and the intent —
 * "these people should be in this group" — is satisfied either way.
 */
export async function addGroupMembers(
  conversationId: string,
  viewerId: AuthUserId,
  userIds: AuthUserId[],
): Promise<GroupChangeResult & { added: AuthUserId[]; systemMessages: MessageRow[] }> {
  const { role } = await requireGroupRole(conversationId, viewerId);
  if (!canManageGroup(role)) throw new HttpError(403, "Only the owner or an admin can add people.");

  const wanted = [...new Set(userIds.map(String))].filter(Boolean);
  if (!wanted.length) throw new HttpError(400, "Nobody was selected.");

  // Active logins only, and only ones not already here. Both checked in the
  // database rather than against a list the client sent.
  const candidates = (await sql`
    SELECT u.id, u.display_name
      FROM auth_users u
     WHERE u.id = ANY(${wanted}::uuid[])
       AND u.active = true
       AND NOT EXISTS (
         SELECT 1 FROM chat_members m
          WHERE m.conversation_id = ${conversationId} AND m.user_id = u.id
       )
     ORDER BY u.display_name
  `) as { id: string; display_name: string }[];

  if (!candidates.length) throw new HttpError(409, "They're all in this group already.");

  const actorName = await displayNameOf(viewerId);

  const systemMessages = await withTransaction(async (client) => {
    const written: MessageRow[] = [];

    for (const person of candidates) {
      const inserted = await client.query(
        `INSERT INTO chat_members (conversation_id, user_id, member_role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversationId, person.id],
      );
      // Lost a race with another admin adding the same person. Their line is
      // already in the thread; a second one would double it.
      if (!inserted.rowCount) continue;

      written.push(
        await writeSystemMessage(client, conversationId, viewerId, "member.added", actorName, {
          targetName: person.display_name,
        }),
      );
    }

    await touchGroup(client, conversationId);
    return written;
  });

  if (!systemMessages.length) throw new HttpError(409, "They're all in this group already.");

  return {
    added: candidates.map((c) => c.id),
    systemMessages,
    // The last one, for callers that only need the conversation's newest activity.
    systemMessage: systemMessages[systemMessages.length - 1]!,
    members: await memberIds(conversationId),
  };
}

/**
 * Removes somebody else from a group.
 *
 * Not the path for leaving — see `leaveGroup`. Refusing self-removal here is what
 * keeps the two apart, so "left the group" and "was removed" stay honestly
 * different lines in the history.
 *
 * Their messages stay. `chat_messages.sender_id` references auth_users, not
 * chat_members, so nothing about the thread changes when a membership row goes —
 * which is the whole reason removal can be a plain DELETE.
 */
export async function removeGroupMember(
  conversationId: string,
  viewerId: AuthUserId,
  targetUserId: AuthUserId,
): Promise<GroupChangeResult> {
  const { role } = await requireGroupRole(conversationId, viewerId);

  const members = await groupMembers(conversationId);
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) throw new HttpError(404, "They're not in this group.");

  if (!canRemoveMember(role, target.role, { samePerson: targetUserId === viewerId })) {
    // Deliberately specific about WHY, because the three reasons have three
    // different fixes: leave instead, ask the owner, or you cannot.
    if (targetUserId === viewerId) {
      throw new HttpError(400, "Use Leave group to remove yourself.");
    }
    if (target.role === "owner") {
      throw new HttpError(403, "The owner can't be removed — they can leave, which hands the group on.");
    }
    throw new HttpError(403, "Only the owner can remove an admin.");
  }

  const actorName = await displayNameOf(viewerId);

  const systemMessage = await withTransaction(async (client) => {
    await client.query("DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2", [
      conversationId,
      targetUserId,
    ]);
    await touchGroup(client, conversationId);
    return writeSystemMessage(client, conversationId, viewerId, "member.removed", actorName, {
      targetName: target.displayName,
    });
  });

  return {
    systemMessage,
    members: await memberIds(conversationId),
    departedUserId: targetUserId,
  };
}

/**
 * Leaves a group.
 *
 * ── The owner's departure ──
 *
 * An owner leaving hands the title to the longest-standing admin, or failing that
 * the longest-standing member (`successorTo`). This is not a courtesy: migration
 * 0004 has a unique partial index guaranteeing exactly one owner per
 * conversation, and a group with none could never be renamed, never gain a
 * member, and never have the state fixed from inside.
 *
 * If the leaver was the last member the conversation is deleted outright, taking
 * its messages, reactions and avatar with it by cascade. The alternative — an
 * empty conversation nobody can see, reach or clean up — is a row that exists
 * only to be a leak.
 *
 * A DM cannot be left (`requireGroupRole` refuses one). There is nothing to leave
 * it to, and the conversation would become unreachable for the other person
 * mid-thread; muting is what that question actually wants.
 */
export async function leaveGroup(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<{
  systemMessage: MessageRow | null;
  members: AuthUserId[];
  deleted: boolean;
  newOwnerId: AuthUserId | null;
}> {
  await requireGroupRole(conversationId, viewerId);

  const members = await groupMembers(conversationId);
  const me = members.find((m) => m.userId === viewerId)!;
  const successor = me.role === "owner" ? successorTo(viewerId, members) : null;

  // The last one out.
  if (members.length === 1) {
    await sql`DELETE FROM chat_conversations WHERE id = ${conversationId}`;
    return { systemMessage: null, members: [], deleted: true, newOwnerId: null };
  }

  const actorName = await displayNameOf(viewerId);

  const systemMessage = await withTransaction(async (client) => {
    // ── The order matters, and it is the opposite of the intuitive one ──
    //
    // The leaver's row goes FIRST, then the successor is promoted. Promoting
    // first would put two owners in the table for the rest of the statement, and
    // `chat_members_one_owner_idx` refuses that immediately — a unique index is
    // not deferred, so the promotion fails and nobody ever leaves.
    //
    // This way there is a moment inside the transaction with no owner at all,
    // which the index permits (it forbids two, not zero) and which nothing
    // outside the transaction can observe.
    await client.query("DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2", [
      conversationId,
      viewerId,
    ]);
    if (successor) {
      await client.query(
        "UPDATE chat_members SET member_role = 'owner' WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, successor],
      );
    }
    await touchGroup(client, conversationId);
    // Written with the leaver as sender even though they are no longer a member:
    // sender_id references auth_users, and the line is about them.
    return writeSystemMessage(client, conversationId, viewerId, "member.left", actorName);
  });

  return {
    systemMessage,
    members: await memberIds(conversationId),
    deleted: false,
    newOwnerId: successor,
  };
}

/**
 * Promotes a member to admin, or demotes an admin back.
 *
 * The owner's alone. An admin who could appoint admins could appoint enough of
 * them to outvote the owner in every practical sense, which makes the tier
 * meaningless.
 *
 * Transferring ownership outright is deliberately NOT here. It is a different
 * operation with a different failure mode — you cannot undo it yourself — and
 * until somebody asks for it, leaveGroup's succession covers the case that
 * actually comes up.
 */
export async function setGroupMemberRole(
  conversationId: string,
  viewerId: AuthUserId,
  targetUserId: AuthUserId,
  nextRole: "admin" | "member",
): Promise<GroupChangeResult> {
  const { role } = await requireGroupRole(conversationId, viewerId);
  if (!canManageRoles(role)) throw new HttpError(403, "Only the owner can hand out admin.");
  if (targetUserId === viewerId) {
    throw new HttpError(400, "You're the owner — that is already more than admin.");
  }

  const members = await groupMembers(conversationId);
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) throw new HttpError(404, "They're not in this group.");
  if (target.role === "owner") throw new HttpError(400, "That's the owner.");
  if (target.role === nextRole) {
    throw new HttpError(409, `They're already ${nextRole === "admin" ? "an admin" : "a member"}.`);
  }

  const actorName = await displayNameOf(viewerId);

  const systemMessage = await withTransaction(async (client) => {
    await client.query(
      "UPDATE chat_members SET member_role = $3 WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, targetUserId, nextRole],
    );
    await touchGroup(client, conversationId);
    return writeSystemMessage(client, conversationId, viewerId, "member.role", actorName, {
      targetName: target.displayName,
      role: nextRole,
    });
  });

  return { systemMessage, members: await memberIds(conversationId) };
}

/**
 * Who could still be added to this group.
 *
 * The same list as `messageableUsers` minus the people already in it, computed in
 * SQL rather than by filtering in the dialog — a client-side filter over a list
 * the client fetched separately is wrong for as long as the two requests are
 * apart, and "add" is exactly where that shows up as a 409.
 */
export async function addableUsers(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<
  { id: string; displayName: string; username: string; role: string; avatarUrl: string | null }[]
> {
  await assertMember(conversationId, viewerId);

  const rows = (await sql`
    SELECT u.id, u.display_name, u.username, u.role, av.updated_at AS avatar_version
      FROM auth_users u
      LEFT JOIN auth_user_avatars av ON av.user_id = u.id
     WHERE u.active = true
       AND NOT EXISTS (
         SELECT 1 FROM chat_members m
          WHERE m.conversation_id = ${conversationId} AND m.user_id = u.id
       )
     ORDER BY u.display_name
  `) as {
    id: string;
    display_name: string;
    username: string;
    role: string;
    avatar_version: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    username: r.username,
    role: r.role,
    avatarUrl: r.avatar_version
      ? `/api/avatar/${r.id}?v=${encodeURIComponent(r.avatar_version)}`
      : null,
  }));
}
