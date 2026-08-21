import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { leaveGroup, removeGroupMember, setGroupMemberRole } from "@/lib/db/queries/chat";
import { publishGroupChange } from "@/lib/chat/publish";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToUser, socketIdFrom } from "@/lib/realtime/server";
import { revalidatePath } from "next/cache";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; userId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Promotes a member to admin, or demotes one back. The owner's alone.
 *
 * See lib/chat/groups.ts for why the tier exists and why only the owner may hand
 * it out.
 */
export const PATCH = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.group.manage", user.id);

  const { id, userId } = await ctx.params;
  if (!UUID.test(userId)) throw new HttpError(404, "They're not in this group.");

  const body = await readJson<{ memberRole?: string }>(req);
  const next = String(body.memberRole ?? "");
  // Only these two. "owner" is not settable through this route — transferring a
  // group is a different operation with a different failure mode, and it does not
  // exist yet (see setGroupMemberRole).
  if (next !== "admin" && next !== "member") {
    throw new HttpError(400, "A member is either an admin or not.");
  }

  const result = await setGroupMemberRole(id, user.id, userId, next);

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: [result.systemMessage],
    socketId: socketIdFrom(req),
  });

  revalidatePath("/chat", "layout");

  return Response.json({ ok: true, memberRole: next });
});

/**
 * Removes somebody, or leaves.
 *
 * ── One route, two operations, decided by who the id belongs to ──
 *
 * Removing yourself IS leaving, and the two produce different histories ("Jamie
 * left the group" rather than "Jamie removed Jamie") and, for an owner, a
 * succession. Rather than two endpoints where a client could aim the wrong one at
 * itself, the server compares the id with the caller and picks. The query layer
 * refuses the confusion from its side too: `removeGroupMember` will not act on
 * the caller, and `leaveGroup` acts only on them.
 *
 * A leave that empties the group deletes the conversation, so there is nothing
 * left to publish to — only the leaver is told, on their own channel.
 */
export const DELETE = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.group.manage", user.id);

  const { id, userId } = await ctx.params;
  if (!UUID.test(userId)) throw new HttpError(404, "They're not in this group.");

  const socketId = socketIdFrom(req);
  const leaving = userId === user.id;

  if (leaving) {
    const result = await leaveGroup(id, user.id);

    if (!result.deleted && result.systemMessage) {
      await publishGroupChange({
        conversationId: id,
        actorId: user.id,
        systemMessages: [result.systemMessage],
        socketId,
      });
    }

    // Told even when the conversation was deleted: this tab has the thread open
    // and needs to stop rendering it either way.
    await publishToUser(user.id, "conversation.removed", { conversationId: id });

    revalidatePath("/chat", "layout");

    return Response.json({ ok: true, left: true, deleted: result.deleted });
  }

  const result = await removeGroupMember(id, user.id, userId);

  await publishGroupChange({
    conversationId: id,
    actorId: user.id,
    systemMessages: [result.systemMessage],
    departedUserId: result.departedUserId,
    socketId,
  });

  revalidatePath("/chat", "layout");

  return Response.json({ ok: true, removed: userId });
});
