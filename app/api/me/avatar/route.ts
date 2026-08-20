import { HttpError, requireUser, withApi } from "@/lib/auth/require";
import {
  AVATAR_ACCEPTED_MIME,
  AVATAR_MAX_BYTES,
  deleteAvatar,
  putAvatar,
} from "@/lib/db/queries/avatars";
import { AVATAR_OPTIONS, optimize } from "@/lib/media/optimizer";
import { requireWithinLimit } from "@/lib/rate-limit";
import { socketIdFrom } from "@/lib/realtime/server";
import { notifyConfig } from "@/lib/revalidate";

export const runtime = "nodejs";

/**
 * Upload your own avatar. `/me/`, not `/users/:id/` — this endpoint can only
 * ever change the caller's own picture, so there is no id to get wrong and no
 * way to aim it at somebody else.
 *
 * The pipeline, in order, because the order is the point:
 *
 *   1. Size checked BEFORE the bytes are looked at. 1 MB, server-side. The
 *      browser checks too, but only so a bad pick is reported instantly — a
 *      client-side limit is a courtesy, never a control.
 *   2. MIME checked against an allowlist. Cheap, and it rejects the obvious.
 *   3. Sent through the optimiser, which is where the real validation happens:
 *      libvips decodes it, so a file that is not genuinely an image fails here.
 *      It comes back as a 256x256 WebP with metadata stripped — which also
 *      means no EXIF GPS from a phone photo, and no payload surviving after the
 *      image data in a polyglot file.
 *   4. Only then stored.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  await requireWithinLimit("avatar.upload", user.id);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof Blob)) throw new HttpError(400, "No image was sent.");
  if (file.size === 0) throw new HttpError(400, "That file is empty.");

  if (file.size > AVATAR_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new HttpError(413, `That image is ${mb} MB. Please use one under 1 MB.`);
  }

  const type = file.type || "";
  if (!AVATAR_ACCEPTED_MIME.includes(type as (typeof AVATAR_ACCEPTED_MIME)[number])) {
    throw new HttpError(415, "Use a PNG, JPEG, WebP, GIF or AVIF image.");
  }

  const outcome = await optimize(file, "avatar", AVATAR_OPTIONS);
  if (!outcome.ok) {
    // 502: the failure is upstream, not in the request. Saying so honestly means
    // a user retries rather than hunting for a problem with their file.
    throw new HttpError(502, outcome.error);
  }

  const { bytes, mime, width, height, originalSize, processedSize } = outcome.result;

  const { updatedAt } = await putAvatar({ userId: user.id, bytes, mime, width, height });

  // An avatar shows up wherever this person does — the account menu, the Users
  // page, chat, and every claim they hold. So it is a board-wide change, not a
  // private one.
  await notifyConfig("login.changed", { userId: user.id }, { socketId: socketIdFrom(req) });

  return Response.json({
    ok: true,
    url: `/api/avatar/${user.id}?v=${encodeURIComponent(updatedAt)}`,
    originalSize,
    processedSize,
    width,
    height,
  });
});

/** Remove it, falling back to initials. */
export const DELETE = withApi(async (req: Request) => {
  const user = await requireUser();
  const removed = await deleteAvatar(user.id);

  if (removed) {
    await notifyConfig("login.changed", { userId: user.id }, { socketId: socketIdFrom(req) });
  }
  return Response.json({ ok: true, removed });
});
