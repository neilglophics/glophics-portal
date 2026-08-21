import { withApi } from "@/lib/auth/require";
import { requireCron } from "@/lib/cron";
import { pruneExpiredSessions } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { sweepStaleStaged } from "@/lib/db/queries/attachments";
import { deleteAttachment } from "@/lib/blob/store";

export const runtime = "nodejs";

/**
 * Daily housekeeping.
 *
 * Right now that is only expired sessions and stale lockout rows. `resolveSession`
 * checks `expires_at` itself and never trusts this to have run, so a missed pass
 * costs disk, not correctness.
 *
 * It now also sweeps **abandoned attachment uploads**, which is the reconciliation
 * this comment used to promise. Somebody picks a file — it uploads immediately, so
 * they can see its size and a progress bar — and then closes the tab without
 * sending. The row is left with `message_id IS NULL` and the bytes are left in the
 * blob store, where nothing in the app can find them and so nobody will ever clean
 * them up by hand.
 *
 * A missed pass costs storage, not correctness: a staged row is invisible to
 * everyone but its uploader, and `attachmentForDownload` refuses it to anybody
 * else.
 *
 * Still outstanding: purging the blobs of messages that were soft-deleted, which
 * waits on a retention period being decided (docs/06-OPEN-QUESTIONS.md Q8). Those
 * files are already unreachable through the app the moment the message is deleted
 * — this is about eventually stopping paying for them.
 */
export const GET = withApi(async (req: Request) => {
  requireCron(req);

  const sessions = await pruneExpiredSessions();

  const lockouts = (await sql`
    DELETE FROM auth_login_attempts
     WHERE locked_until IS NOT NULL AND locked_until < now() - interval '1 day'
     RETURNING username
  `) as unknown[];

  // Rows for windows nobody is inside any more. The limiter itself restarts an
  // elapsed window on next use, so these are dead weight rather than state.
  const limits = (await sql`
    DELETE FROM rate_limits WHERE window_start < now() - interval '1 day' RETURNING key
  `) as unknown[];

  // Rows first, then bytes. A row with no bytes renders as a broken download;
  // bytes with no row are merely invisible, and a later pass would have collected
  // them anyway. If the blob deletes fail, the harmless failure is the one left.
  const abandonedBlobs = await sweepStaleStaged(24);
  let blobsDeleted = 0;
  for (const url of abandonedBlobs) {
    // Never throws — see the note on deleteAttachment. One stubborn file must not
    // abort the rest of the housekeeping.
    if (await deleteAttachment(url)) blobsDeleted += 1;
  }

  return Response.json({
    ok: true,
    sessionsPruned: sessions,
    lockoutsCleared: lockouts.length,
    rateLimitRowsCleared: limits.length,
    abandonedUploadsCleared: abandonedBlobs.length,
    attachmentBlobsDeleted: blobsDeleted,
  });
});
