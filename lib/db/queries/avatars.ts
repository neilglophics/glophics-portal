/**
 * Avatar storage.
 *
 * Bytes live in Postgres (see lib/db/migrations/0003_avatars.sql for why), in
 * their own table so the per-request session lookup on auth_users can never drag
 * an image into memory.
 */

import { sql } from "@/lib/db/client";

/**
 * What a user may SEND. The stored result is the optimiser's output, which for
 * a 256x256 WebP is a couple of kilobytes — so this bounds the upload, not the
 * storage.
 *
 * Enforced on the server because that is the only place it counts. The browser
 * also checks it, purely so somebody picking a 12 MB photo is told immediately
 * instead of after the upload.
 */
export const AVATAR_MAX_BYTES = 1024 * 1024;

/** What a file picker will accept, and what the server will agree to forward. */
export const AVATAR_ACCEPTED_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export interface StoredAvatar {
  bytes: Buffer;
  mime: string;
  updatedAt: string;
}

export async function putAvatar(input: {
  userId: string;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
}): Promise<{ updatedAt: string }> {
  const rows = (await sql`
    INSERT INTO auth_user_avatars (user_id, bytes, mime, width, height, byte_size, updated_at)
    VALUES (${input.userId}, ${input.bytes}, ${input.mime},
            ${input.width}, ${input.height}, ${input.bytes.length}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
      width = EXCLUDED.width, height = EXCLUDED.height,
      byte_size = EXCLUDED.byte_size, updated_at = now()
    RETURNING updated_at
  `) as { updated_at: string }[];

  return { updatedAt: rows[0]!.updated_at };
}

/**
 * The driver hands bytea back as a Buffer, or as a hex string in some paths.
 * Normalising here means no route has to care which — and there are two callers
 * now, one for a person's face and one for a group's.
 */
function toBuffer(value: unknown): Buffer {
  return typeof value === "string"
    ? Buffer.from(value.replace(/^\\x/, ""), "hex")
    : Buffer.from(value as Uint8Array);
}

export async function getAvatar(userId: string): Promise<StoredAvatar | null> {
  const rows = (await sql`
    SELECT bytes, mime, updated_at FROM auth_user_avatars WHERE user_id = ${userId}
  `) as { bytes: unknown; mime: string; updated_at: string }[];

  const row = rows[0];
  if (!row) return null;

  return { bytes: toBuffer(row.bytes), mime: row.mime, updatedAt: row.updated_at };
}

export async function deleteAvatar(userId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM auth_user_avatars WHERE user_id = ${userId} RETURNING user_id
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Which logins have an avatar, and when it last changed.
 *
 * Returned as a map so a page rendering many people does one query rather than
 * one per row — and so the URL can carry `?v=<updatedAt>`, which is what lets
 * the image be cached hard while still updating the moment somebody uploads.
 */
export async function avatarVersions(): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT user_id, updated_at FROM auth_user_avatars
  `) as { user_id: string; updated_at: string }[];

  return new Map(rows.map((r) => [r.user_id, r.updated_at]));
}

// ---------- group avatars ----------

/**
 * A group's photo.
 *
 * Same table shape, same functions, same reasoning as a person's — see
 * lib/db/migrations/0004_chat_reactions_and_groups.sql. Kept in this module
 * rather than in queries/chat.ts because what it is doing is avatar storage, and
 * a second copy of "normalise bytea, hand back a Buffer" would be a second place
 * to get that wrong.
 *
 * There is no capability check here. The route that calls it does that, and the
 * permission question — owner or admin — belongs to the group, not to the bytes.
 */
export async function putConversationAvatar(input: {
  conversationId: string;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
}): Promise<{ updatedAt: string }> {
  const rows = (await sql`
    INSERT INTO chat_conversation_avatars
      (conversation_id, bytes, mime, width, height, byte_size, updated_at)
    VALUES (${input.conversationId}, ${input.bytes}, ${input.mime},
            ${input.width}, ${input.height}, ${input.bytes.length}, now())
    ON CONFLICT (conversation_id) DO UPDATE SET
      bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
      width = EXCLUDED.width, height = EXCLUDED.height,
      byte_size = EXCLUDED.byte_size, updated_at = now()
    RETURNING updated_at
  `) as { updated_at: string }[];

  return { updatedAt: rows[0]!.updated_at };
}

export async function getConversationAvatar(conversationId: string): Promise<StoredAvatar | null> {
  const rows = (await sql`
    SELECT bytes, mime, updated_at FROM chat_conversation_avatars
     WHERE conversation_id = ${conversationId}
  `) as { bytes: unknown; mime: string; updated_at: string }[];

  const row = rows[0];
  if (!row) return null;

  return { bytes: toBuffer(row.bytes), mime: row.mime, updatedAt: row.updated_at };
}

export async function deleteConversationAvatar(conversationId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM chat_conversation_avatars WHERE conversation_id = ${conversationId}
    RETURNING conversation_id
  `) as unknown[];
  return rows.length > 0;
}

/** The URL for a login's avatar, or null when they have not uploaded one. */
export function avatarUrl(userId: string | null, versions: Map<string, string>): string | null {
  if (!userId) return null;
  const version = versions.get(userId);
  if (!version) return null;
  return `/api/avatar/${userId}?v=${encodeURIComponent(version)}`;
}
