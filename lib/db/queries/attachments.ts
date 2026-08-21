/**
 * Attachment metadata. The bytes live in Vercel Blob (lib/blob/store.ts); only
 * this describes them.
 *
 * ── The one rule, again ──
 *
 * MEMBERSHIP IS THE AUTHORIZATION BOUNDARY, exactly as in queries/chat.ts. Every
 * read here proves membership on the same call, and the write path additionally
 * proves *ownership* of a staged row — see `claimAttachments`.
 *
 * ── The lifecycle, which is the only complicated thing here ──
 *
 *   1. somebody picks a file        → `stageAttachment` writes a row with
 *                                     message_id NULL and uploaded_by = them
 *   2. they hit send                → `claimAttachments` sets message_id, inside
 *                                     the message's own transaction
 *   3. they never hit send          → `sweepStaleStaged` removes it, and the blob
 *
 * A NULL `message_id` therefore means precisely "staged, not sent", and it is the
 * only state that needs cleaning up. Nothing else in the app has to know this
 * exists.
 */

import { sql } from "@/lib/db/client";
import type { PoolClient } from "@neondatabase/serverless";
import { HttpError } from "@/lib/auth/require";
import { assertMember } from "@/lib/db/queries/chat";
import type { AuthUserId } from "@/lib/types";

/**
 * What a client is allowed to know about an attachment.
 *
 * `blobPathname` and `blobUrl` are deliberately absent. They are how the server
 * finds the bytes; the client gets an id and asks this app for them, so that
 * membership is checked on every single read rather than once at send time.
 */
export interface AttachmentView {
  id: string;
  messageId: number | null;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  message_id: string | number | null;
  filename: string;
  mime: string;
  bytes: string | number;
  width: number | null;
  height: number | null;
  created_at: string;
}

function toView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    messageId: row.message_id === null ? null : Number(row.message_id),
    filename: row.filename,
    mime: row.mime,
    // bigint arrives as a string from the driver — coerced here so the client
    // never has to guess whether a size is a number or a string.
    bytes: Number(row.bytes),
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

/**
 * Records an uploaded file, not yet attached to any message.
 *
 * Called after the bytes are safely in the blob store, never before: a row
 * pointing at bytes that failed to upload would be an attachment that renders as
 * a broken download, and the sweep would never find it because the sweep deletes
 * blobs, not rows.
 */
export async function stageAttachment(input: {
  conversationId: string;
  uploadedBy: AuthUserId;
  blobUrl: string;
  blobPathname: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
}): Promise<AttachmentView> {
  const rows = (await sql`
    INSERT INTO chat_attachments
      (conversation_id, uploaded_by, blob_url, blob_pathname,
       filename, mime, bytes, width, height)
    VALUES (${input.conversationId}, ${input.uploadedBy}, ${input.blobUrl}, ${input.blobPathname},
            ${input.filename}, ${input.mime}, ${input.bytes}, ${input.width}, ${input.height})
    RETURNING id, message_id, filename, mime, bytes, width, height, created_at
  `) as AttachmentRow[];

  return toView(rows[0]!);
}

/**
 * Attaches staged files to a message, inside the send transaction.
 *
 * ── This is the security-critical function in this file ──
 *
 * It takes ids from a request body, so every one of the four conditions in the
 * WHERE clause is load-bearing:
 *
 *   `id = ANY(...)`            the ones asked for
 *   `conversation_id = $1`     staged for THIS conversation, so a file uploaded
 *                              to a private thread cannot be re-pointed into
 *                              another one
 *   `uploaded_by = $2`         staged by THIS person, so one member cannot attach
 *                              another member's pending file by guessing its id
 *   `message_id IS NULL`       not already sent, so an attachment cannot be
 *                              re-used to make it look as though it were sent
 *                              twice, or moved off the message it belongs to
 *
 * The count is then compared against what was asked for and a mismatch is an
 * error, not a partial success. Silently sending four of five files is worse than
 * refusing: the sender believes all five went.
 */
export async function claimAttachments(
  client: PoolClient,
  input: {
    conversationId: string;
    messageId: number;
    uploaderId: AuthUserId;
    attachmentIds: string[];
  },
): Promise<AttachmentView[]> {
  if (!input.attachmentIds.length) return [];

  const result = await client.query<AttachmentRow>(
    `UPDATE chat_attachments
        SET message_id = $3
      WHERE id = ANY($4::uuid[])
        AND conversation_id = $1
        AND uploaded_by = $2
        AND message_id IS NULL
      RETURNING id, message_id, filename, mime, bytes, width, height, created_at`,
    [input.conversationId, input.uploaderId, input.messageId, input.attachmentIds],
  );

  if (result.rows.length !== input.attachmentIds.length) {
    // Rolls the whole send back — the caller runs this inside the message's
    // transaction, so the message goes with it. A message that claims to have
    // five files and has four is not a message anybody wants to have sent.
    throw new HttpError(400, "Some of those files are no longer available. Try attaching them again.");
  }

  // Ordered for a stable render: the bubble should lay files out the same way
  // every time it is painted, and `RETURNING` makes no promise about order.
  return result.rows.map(toView).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The viewer's own staged-but-unsent files in a conversation. Rehydrates a
 *  composer after a reload, so a 20 MB upload is not silently thrown away by a
 *  stray refresh. */
export async function stagedAttachments(
  conversationId: string,
  viewerId: AuthUserId,
): Promise<AttachmentView[]> {
  await assertMember(conversationId, viewerId);

  const rows = (await sql`
    SELECT id, message_id, filename, mime, bytes, width, height, created_at
      FROM chat_attachments
     WHERE conversation_id = ${conversationId}
       AND uploaded_by = ${viewerId}
       AND message_id IS NULL
     ORDER BY created_at
  `) as AttachmentRow[];

  return rows.map(toView);
}

/**
 * Everything the download route needs, in one query that also authorizes.
 *
 * Membership is in the JOIN rather than in a separate call, so there is no
 * ordering in which a caller reads the blob path before proving they may. A
 * non-member and a nonexistent id both come back null and both answer 404 —
 * "not found" is true from the viewer's point of view either way, and a 403 would
 * confirm which ids are real.
 */
export async function attachmentForDownload(
  attachmentId: string,
  viewerId: AuthUserId,
): Promise<{ filename: string; mime: string; bytes: number; blobPathname: string } | null> {
  const rows = (await sql`
    SELECT a.filename, a.mime, a.bytes, a.blob_pathname
      FROM chat_attachments a
      JOIN chat_members m
        ON m.conversation_id = a.conversation_id AND m.user_id = ${viewerId}
      LEFT JOIN chat_messages msg ON msg.id = a.message_id
     WHERE a.id = ${attachmentId}
       -- A staged file is readable only by whoever staged it: until it is sent it
       -- is not part of the conversation, it is somebody's draft.
       AND (a.message_id IS NOT NULL OR a.uploaded_by = ${viewerId})
       -- A deleted message takes its attachments out of reach with it. The row
       -- survives for the retention sweep to collect; the bytes stop being
       -- served the moment the message is withdrawn.
       AND (msg.id IS NULL OR msg.deleted_at IS NULL)
     LIMIT 1
  `) as { filename: string; mime: string; bytes: string | number; blob_pathname: string }[];

  const row = rows[0];
  if (!row) return null;

  return {
    filename: row.filename,
    mime: row.mime,
    bytes: Number(row.bytes),
    blobPathname: row.blob_pathname,
  };
}

/**
 * Discards a staged file — the composer's remove button.
 *
 * Only ever a staged one. Removing an attachment from a message that has already
 * been sent is editing history, which is what deleting the message is for.
 * Returns the blob location so the route can delete the bytes too.
 */
export async function discardStagedAttachment(
  attachmentId: string,
  viewerId: AuthUserId,
): Promise<{ blobUrl: string } | null> {
  const rows = (await sql`
    DELETE FROM chat_attachments
     WHERE id = ${attachmentId}
       AND uploaded_by = ${viewerId}
       AND message_id IS NULL
    RETURNING blob_url
  `) as { blob_url: string }[];

  return rows[0] ? { blobUrl: rows[0].blob_url } : null;
}

/** The blob locations belonging to a message, for the retention sweep to delete
 *  once a soft-deleted message is finally purged. */
export async function attachmentBlobsForMessage(messageId: number): Promise<string[]> {
  const rows = (await sql`
    SELECT blob_url FROM chat_attachments WHERE message_id = ${messageId}
  `) as { blob_url: string }[];
  return rows.map((r) => r.blob_url);
}

/**
 * Rows staged and abandoned. Somebody picked a file and closed the tab.
 *
 * Deletes the rows and hands back the blob locations, because the bytes are the
 * part that costs money — an orphaned row is a few bytes in Postgres, an orphaned
 * blob is storage nobody can find through the app and therefore nobody will ever
 * clean up by hand.
 *
 * A day rather than an hour: the point is to catch abandonment, and somebody who
 * attached a file, went to a meeting and came back to the same tab should still
 * find it there.
 */
export async function sweepStaleStaged(olderThanHours = 24): Promise<string[]> {
  const rows = (await sql`
    DELETE FROM chat_attachments
     WHERE message_id IS NULL
       AND created_at < now() - make_interval(hours => ${olderThanHours}::int)
    RETURNING blob_url
  `) as { blob_url: string }[];

  return rows.map((r) => r.blob_url);
}
