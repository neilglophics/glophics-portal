import { requireUser, withApi } from "@/lib/auth/require";
import {
  attachmentForDownload,
  discardStagedAttachment,
} from "@/lib/db/queries/attachments";
import { deleteAttachment, readAttachment } from "@/lib/blob/store";
import { attachmentKind } from "@/lib/chat/attachments";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ attachmentId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves one attachment. THE reason attachments are private at all.
 *
 * ── Why a proxy and not a direct link ──
 *
 * docs/06-OPEN-QUESTIONS.md Q6 asked whether a Blob URL is a capability anybody
 * holding it can read forever. For this store the question is settled by
 * configuration: it is a **private** store, an unauthenticated GET of a blob URL
 * answers 403, and reads are only possible server-side with the token. So this
 * route is not a discipline we are choosing to keep — it is the only way to read
 * the bytes, which is the strongest form the answer could take.
 *
 * Membership is re-checked on **every** read, not once at send time. That is what
 * makes access revocable: somebody removed from a group stops being able to open
 * the files in it, and a link pasted into an email is worthless to whoever
 * receives it. `attachmentForDownload` puts the membership join in the same query
 * as the blob path, so there is no ordering in which a caller reads the path
 * before proving they may.
 *
 * ── Content-Disposition is a security control here ──
 *
 * Files are stored as sent, and the only types stored unprocessed are documents.
 * They are served `attachment` — download, never render — so a text/html or
 * text/plain file cannot execute in this origin, which is the origin holding
 * everybody's session cookie. Only images and PDFs are served `inline`, and images
 * have already been re-encoded through the optimiser, so an image reaching here is
 * one libvips decoded and rewrote.
 *
 * `?download=1` forces the attachment disposition for anything, which is what the
 * "Download" action on a file card uses.
 */
export const GET = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { attachmentId } = await ctx.params;

  if (!UUID.test(attachmentId)) {
    return new Response("Not found", { status: 404 });
  }

  // Returns null for a nonexistent id, a non-member, and a deleted message alike.
  // All three answer 404: "not found" is true from the viewer's point of view, and
  // a 403 would confirm which ids are real.
  const meta = await attachmentForDownload(attachmentId, user.id);
  if (!meta) return new Response("Not found", { status: 404 });

  const blob = await readAttachment(meta.blobPathname);
  if (!blob) {
    // The row exists and the bytes do not. Logged, because it means the database
    // and the store have drifted — something deleted a blob without its row.
    console.error(`[attachment] ${attachmentId} has no bytes at ${meta.blobPathname}`);
    return new Response("Not found", { status: 404 });
  }

  const kind = attachmentKind(meta.mime);
  const forceDownload = new URL(req.url).searchParams.get("download") === "1";
  const inline = !forceDownload && (kind === "image" || kind === "pdf");

  return new Response(blob.stream, {
    status: 200,
    headers: {
      "Content-Type": meta.mime,
      ...(blob.size ? { "Content-Length": String(blob.size) } : {}),
      // The filename is quoted and its quotes escaped. It is user input reaching a
      // header — `safeFilename` already stripped control characters on the way in,
      // and this closes the quoting half.
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename.replace(
        /"/g,
        "'",
      )}"`,
      // `private`, because this response is only authorised for this viewer and
      // must never land in a shared cache. Immutable is safe without a version
      // parameter because an attachment's bytes never change — there is no edit
      // path, only delete.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Belt and braces on a route that returns user-supplied bytes. The global
      // header covers this too; being explicit here costs nothing.
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/**
 * Discards a staged file — the composer's remove button.
 *
 * Only ever a staged one, enforced in `discardStagedAttachment`: removing a file
 * from a message that has already been sent is editing history, which is what
 * deleting the message is for.
 *
 * The row goes first, then the bytes. That order matters: a row with no bytes
 * renders as a broken download, while bytes with no row are invisible and get
 * collected by the sweep. If the second step fails, the worse outcome is the one
 * that did not happen.
 */
export const DELETE = withApi(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { attachmentId } = await ctx.params;

  if (!UUID.test(attachmentId)) {
    return Response.json({ ok: true, removed: false });
  }

  const discarded = await discardStagedAttachment(attachmentId, user.id);
  if (!discarded) {
    // Idempotent: removing something already gone is a success. A retry after a
    // dropped response is the normal case, not an edge case.
    return Response.json({ ok: true, removed: false });
  }

  await deleteAttachment(discarded.blobUrl);

  return Response.json({ ok: true, removed: true });
});
