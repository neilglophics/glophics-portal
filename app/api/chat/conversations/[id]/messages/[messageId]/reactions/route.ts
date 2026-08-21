import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { toggleReaction } from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToConversation } from "@/lib/realtime/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; messageId: string }> };

/**
 * Adds or removes the caller's reaction to a message.
 *
 * ── One endpoint, not add and remove ──
 *
 * The gesture is a toggle: you tap a pill and your reaction goes on or comes off.
 * Splitting that into POST-to-add and DELETE-to-remove would make the CLIENT
 * decide which one applies, from a copy of the state that may already be a tap
 * behind — and a stale guess there means "add" when the row is already there or
 * "remove" when it is not. The server knows, in one statement, so it decides. See
 * `toggleReaction` for how that stays race-free.
 *
 * POST rather than GET, like every other mutation here: there are no CSRF tokens
 * in this app and `SameSite=Lax` is what carries the protection, which a
 * state-changing GET would silently give up.
 *
 * ── Not excluded from its own fan-out ──
 *
 * Unlike sending a message, this publishes to the WHOLE conversation including the
 * acting tab. The pill it painted optimistically has to be reconciled against
 * server truth — somebody else's simultaneous tap changes the count it guessed —
 * and `reaction.changed` carries the emoji's complete membership, so applying it
 * twice is the same as applying it once. There is no double-render to avoid.
 */
export const POST = withApi(async (req: Request, ctx: Ctx) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.reaction", user.id);

  const { id, messageId } = await ctx.params;
  const body = await readJson<{ emoji?: string }>(req);

  const numeric = Number(messageId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return Response.json({ ok: false, error: "No such message." }, { status: 404 });
  }

  // The emoji is validated against the allowlist inside toggleReaction, not here:
  // the check belongs next to the write, where nothing can reach the table
  // without passing it.
  const result = await toggleReaction(id, numeric, user.id, String(body.emoji ?? ""));

  await publishToConversation(id, "reaction.changed", {
    messageId: numeric,
    conversationId: id,
    emoji: result.group.emoji,
    users: result.group.users,
  });

  // Reactions deliberately do NOT touch unread counts or last_message_at. A
  // thumbs-up is acknowledgement, not a message: bumping a conversation to the
  // top of everyone's list and lighting up a badge for one would make the cheapest
  // gesture in the app the loudest.

  return Response.json({ ok: true, added: result.added, reaction: result.group });
});
