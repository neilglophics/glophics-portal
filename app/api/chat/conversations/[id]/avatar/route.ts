import { HttpError, requireUser, withApi } from "@/lib/auth/require";
import {
  AVATAR_ACCEPTED_MIME,
  AVATAR_MAX_BYTES,
  deleteConversationAvatar,
  getConversationAvatar,
  putConversationAvatar,
} from "@/lib/db/queries/avatars";
import {
  assertCanManageGroup,
  assertMember,
  recordGroupAvatarChange,
} from "@/lib/db/queries/chat";
import { publishGroupChange } from "@/lib/chat/publish";
import { AVATAR_OPTIONS, optimize } from "@/lib/media/optimizer";
import { requireWithinLimit } from "@/lib/rate-limit";
import { socketIdFrom } from "@/lib/realtime/server";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A group's photo — read, replace, remove.
 *
 * Three methods on one route because they are three verbs on one resource, and
 * splitting them would only give the membership check three places to live.
 *
 * ── Reading it needs membership, not a capability ──
 *
 * A group avatar is only meaningful to its members, and serving it to anybody who
 * knows a conversation id would make it public in every way that matters. So the
 * GET calls `assertMember` — the same boundary as the messages themselves. That is
 * also why these bytes are in Postgres rather than Blob: a Blob URL is a
 * capability nobody can withdraw, and this route can ask who is asking.
 *
 * ── Writing it needs owner or admin ──
 *
 * Checked by `recordGroupAvatarChange`, which is also what writes the system
 * message. Called BEFORE the bytes are stored, deliberately: a member with no
 * business changing the photo should be refused without an optimiser round trip
 * happening on their behalf.
 */
export const GET = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  // Membership is the authorization. A 404 for a non-member, same as everywhere
  // else in chat, so nothing confirms which ids are real.
  await assertMember(id, user.id);

  const avatar = await getConversationAvatar(id);
  if (!avatar) {
    // Not a placeholder image: the caller renders initials from the group name,
    // and a generated fallback here would hide "has no photo" behind a
    // successful-looking response.
    return new Response("Not found", { status: 404 });
  }

  const etag = `"${id}-${Date.parse(avatar.updatedAt)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(new Uint8Array(avatar.bytes), {
    status: 200,
    headers: {
      "Content-Type": avatar.mime,
      "Content-Length": String(avatar.bytes.length),
      // `immutable` is safe because the URL carries ?v=<updated timestamp>: a new
      // upload is a different URL. `private`, because this response is only
      // authorised for this viewer.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});

/**
 * Replaces the photo.
 *
 * The pipeline is the one in /api/me/avatar, in the same order and for the same
 * reasons: size first, then MIME against an allowlist, then through the optimiser
 * — which is where the real validation happens, because libvips decodes it, so a
 * file that is not genuinely an image fails there rather than being stored. What
 * comes back is a 256px WebP with metadata stripped, so no EXIF GPS from
 * somebody's phone and nothing surviving after the image data in a polyglot file.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("avatar.upload", user.id);

  const { id } = await ctx.params;

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

  // Permission and the group's existence, before any of the expensive work. This
  // throws for a DM, a non-member and a plain member alike — so nobody without
  // business here gets a round trip to the optimiser on their behalf.
  await assertCanManageGroup(id, user.id, "change the group photo");

  const outcome = await optimize(file, "group-avatar", AVATAR_OPTIONS);
  if (!outcome.ok) {
    // 502: the failure is upstream, not in the request. Saying so honestly means
    // somebody retries rather than hunting for a problem with their file.
    throw new HttpError(502, outcome.error);
  }

  const { bytes, mime, width, height, originalSize, processedSize } = outcome.result;
  const { updatedAt } = await putConversationAvatar({
    conversationId: id,
    bytes,
    mime,
    width,
    height,
  });

  // The system message is written only now, after the bytes are actually stored.
  // Announcing a photo that failed at the optimiser would be a line in the
  // thread the group has no way to correct.
  const change = await recordGroupAvatarChange(id, user.id);

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: [change.systemMessage],
    socketId: socketIdFrom(req),
    updated: { title: null, avatarVersion: updatedAt },
  });

  revalidatePath("/chat", "layout");

  return Response.json({
    ok: true,
    url: `/api/chat/conversations/${id}/avatar?v=${encodeURIComponent(updatedAt)}`,
    originalSize,
    processedSize,
    width,
    height,
  });
});

/** Removes it, falling back to initials of the group's name. */
export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  const { id } = await ctx.params;

  await assertCanManageGroup(id, user.id, "change the group photo");

  const removed = await deleteConversationAvatar(id);
  if (!removed) {
    // Nothing to remove and nothing happened, so no system message claiming
    // otherwise. Still ok — the group has no photo, which is what was asked for.
    return Response.json({ ok: true, removed: false });
  }

  const change = await recordGroupAvatarChange(id, user.id);

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: [change.systemMessage],
    socketId: socketIdFrom(req),
    // Null version, and the client refetches: there is no photo to point at.
    updated: { title: null, avatarVersion: null },
  });

  revalidatePath("/chat", "layout");

  return Response.json({ ok: true, removed });
});
