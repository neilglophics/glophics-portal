import { HttpError, requireUser, withApi } from "@/lib/auth/require";
import { assertMember } from "@/lib/db/queries/chat";
import { stageAttachment, stagedAttachments } from "@/lib/db/queries/attachments";
import { isBlobConfigured, putAttachment } from "@/lib/blob/store";
import {
  ATTACHMENT_MAX_BYTES,
  GIF_MAX_BYTES,
  attachmentKind,
  gifDimensions,
  isStoredVerbatim,
  looksLikeGif,
  safeFilename,
  validateAttachment,
} from "@/lib/chat/attachments";
import { ATTACHMENT_OPTIONS, optimize } from "@/lib/media/optimizer";
import { requireWithinLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The viewer's own staged-but-unsent files in this conversation.
 *
 * Rehydrates the composer after a reload. Without it, picking a 20 MB file and
 * then hitting refresh silently throws the upload away and leaves the bytes
 * orphaned in the store until the sweep — the user's work lost and the storage
 * still paid for.
 */
export const GET = withApi(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  const attachments = await stagedAttachments(id, user.id);
  return Response.json({ ok: true, attachments });
});

/**
 * Uploads one file and stages it, unattached, for a later send.
 *
 * ── Why upload now rather than at send time ──
 *
 * The composer has to show the file, its size, a remove button and a progress bar
 * while the person can still act on all of it. Deferring the upload to the send
 * would mean a 25 MB file uploads *after* they press Send, with no way to cancel
 * and no way to be told it failed except by the message not appearing.
 *
 * The cost is an interval in which a file is stored and attached to nothing. That
 * is modelled explicitly — `chat_attachments.message_id IS NULL` — and swept by
 * the retention cron. See lib/db/queries/attachments.ts.
 *
 * ── One file per request ──
 *
 * Not a batch, so each file gets its own progress bar and its own error. A single
 * request carrying five files has one status code between them, which means one
 * bad file fails the other four and the person cannot tell which was which.
 *
 * ── The pipeline, in order, because the order is the point ──
 *
 *   1. Membership, before anything is read. A non-member gets no work done for
 *      them.
 *   2. Size and type, from the allowlist that the picker also reads. Checked
 *      before the bytes are touched.
 *   3. Images go through the optimiser, which is where the real validation
 *      happens: libvips decodes it, so a file that is not genuinely an image
 *      fails there rather than being stored. Metadata is stripped, so no EXIF GPS
 *      from a phone photo and nothing surviving after the image data in a
 *      polyglot file.
 *   4. Non-images are stored as sent — a PDF has to stay byte-identical to be
 *      worth attaching — but they are only ever served back with
 *      `Content-Disposition: attachment` and `nosniff`, never rendered in our
 *      origin.
 *   5. Bytes to the blob store.
 *   6. Only then a database row, so a row never points at bytes that failed to
 *      upload.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  // Membership first. This is the check that stops one member's file being staged
  // into somebody else's conversation.
  await assertMember(id, user.id);
  await requireWithinLimit("chat.attachment.upload", user.id);

  if (!isBlobConfigured()) {
    // Honest rather than a 500: attachments are an enhancement, and the rest of
    // chat works. 503 says "not available", which is true and actionable.
    throw new HttpError(503, "File attachments aren't configured on this deployment.");
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof Blob)) throw new HttpError(400, "No file was sent.");

  // `File` carries a name; a bare `Blob` does not. Sanitised either way — this
  // value ends up in a Content-Disposition header.
  const rawName = file instanceof File ? file.name : "file";
  const filename = safeFilename(rawName);

  const verdict = validateAttachment({ name: filename, size: file.size, type: file.type || "" });
  if (!verdict.ok) {
    // 413 for "too big" so a client can distinguish it from "wrong sort of file"
    // and say something useful without parsing prose.
    // A GIF has a lower ceiling of its own, and exceeding it is still a size
    // refusal rather than a type one.
    const tooBig =
      file.size > ATTACHMENT_MAX_BYTES ||
      (isStoredVerbatim(file.type) && file.size > GIF_MAX_BYTES);
    throw new HttpError(tooBig ? 413 : 415, verdict.error);
  }

  const mime = file.type;
  let body: Buffer;
  let width: number | null = null;
  let height: number | null = null;
  let storedMime = mime;
  let storedName = filename;

  if (isStoredVerbatim(mime)) {
    // -- GIFs skip the optimiser entirely --
    //
    // It returns a STATIC WebP for an animated GIF (verified against the live
    // service: a two-frame GIF came back single-frame, no ANIM chunk), so every
    // GIF sent was flattened to its first frame and renamed ".webp". It also
    // refuses anything over 4 MB, which most real GIFs exceed, so the larger ones
    // failed outright. Keeping the bytes fixes both.
    //
    // The consequence worth naming: nothing decodes the file any more, and for
    // every other image type that decode doubled as proof the bytes really were an
    // image. The magic number is the replacement -- see looksLikeGif.
    body = Buffer.from(await file.arrayBuffer());

    if (!looksLikeGif(body)) {
      throw new HttpError(415, "That file says it is a GIF but does not look like one.");
    }

    // Read from the header rather than from a decoder, so the bubble can still
    // reserve the right box and the thread does not reflow when the image lands.
    const size = gifDimensions(body);
    width = size?.width ?? null;
    height = size?.height ?? null;
    // storedMime and storedName are left alone: the stored bytes really are the
    // GIF that was sent, so both should still say so.
  } else if (attachmentKind(mime) === "image") {
    const outcome = await optimize(file, filename, ATTACHMENT_OPTIONS);
    if (!outcome.ok) {
      // 502: the failure is upstream, not in the request. Saying so honestly means
      // somebody retries rather than hunting for a problem with their file.
      throw new HttpError(502, outcome.error);
    }
    body = outcome.result.bytes;
    storedMime = outcome.result.mime;
    width = outcome.result.width || null;
    height = outcome.result.height || null;
    // The stored bytes are WebP now, so the name has to say so or every download
    // lands as a .png that is not one.
    storedName = filename.replace(/\.[^.]+$/, "") + ".webp";
  } else {
    body = Buffer.from(await file.arrayBuffer());
  }

  const stored = await putAttachment({
    conversationId: id,
    filename: storedName,
    contentType: storedMime,
    body,
  });
  if (!stored) throw new HttpError(503, "File storage is unavailable right now.");

  const attachment = await stageAttachment({
    conversationId: id,
    uploadedBy: user.id,
    blobUrl: stored.url,
    blobPathname: stored.pathname,
    filename: storedName,
    mime: storedMime,
    bytes: body.length,
    width,
    height,
  });

  // Nothing is published. A staged file is not part of the conversation yet — it
  // is somebody's draft, and telling the other members about a file that may never
  // be sent would be showing them a keystroke.
  return Response.json({ ok: true, attachment });
});
