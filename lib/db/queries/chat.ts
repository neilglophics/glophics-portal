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
import { HttpError } from "@/lib/auth/require";
import type { AuthUserId } from "@/lib/types";

// ---------- shapes ----------

export interface ConversationSummary {
  id: string;
  kind: "dm" | "group";
  /** For a DM this is the other member's display name, resolved below. */
  title: string;
  createdAt: string;
  lastMessageAt: string | null;
  members: { id: AuthUserId; displayName: string; avatarUrl: string | null }[];
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
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
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
    SELECT c.id, c.kind, c.title, c.created_at, c.last_message_at,
           me.muted, me.last_read_message_id,
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
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  `) as {
    id: string;
    kind: "dm" | "group";
    title: string | null;
    created_at: string;
    last_message_at: string | null;
    muted: boolean;
    unread_count: number;
    last_preview: string | null;
    members: { id: string; displayName: string; avatarVersion: string | null }[];
  }[];

  return rows.map((r) => {
    const members = (r.members ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName,
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
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at,
      members,
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
  const name = title.trim();
  if (!name) throw new HttpError(400, "Give the group a name.");
  if (name.length > 120) throw new HttpError(400, "That name is too long.");

  // The creator is always a member, and duplicates in the payload are collapsed.
  const wanted = [...new Set([viewerId, ...memberIdsIn])];

  const valid = (await sql`
    SELECT id FROM auth_users WHERE id = ANY(${wanted}::uuid[]) AND active = true
  `) as { id: string }[];
  const members = valid.map((r) => r.id);

  if (members.length < 2) throw new HttpError(400, "A group needs at least one other person.");

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
    return conversationId;
  });

  return { id, members };
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
           m.client_msg_id, m.body, m.kind, m.reply_to_id,
           m.created_at, m.edited_at, m.deleted_at
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
    reply_to_id: string | number | null;
    created_at: string;
    edited_at: string | null;
    deleted_at: string | null;
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
      replyToId: r.reply_to_id === null ? null : Number(r.reply_to_id),
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
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

const MAX_BODY = 8000;

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
  if (body.length > MAX_BODY) throw new HttpError(400, "That message is too long.");

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
      replyToId: input.replyToId ?? null,
      createdAt: outcome.row.created_at,
      editedAt: null,
      deletedAt: null,
    },
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
