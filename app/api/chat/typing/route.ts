import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { assertMember } from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToConversation, socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * "Someone is typing."
 *
 * Server-published rather than a Pusher client event, deliberately (ADR-009).
 * Client events let any subscriber publish onto a channel invisibly to the
 * server; a forged typing ping is harmless on its own, but the capability cannot
 * be scoped to one event name — enabling it enables client publishing app-wide,
 * which is a standing hazard as the event vocabulary grows.
 *
 * Never persisted. It is worthless a second later, and there is no `typing.stop`:
 * the receiver lets a ~4-second timer lapse. A stop event would double the volume
 * of the noisiest event in the system to convey what a timeout already conveys.
 *
 * The rate limit here is a backstop. The client throttles to one per 3 seconds;
 * this stops a client that does not.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser("chat");

  const body = await readJson<{ conversationId?: string }>(req);
  const conversationId = String(body.conversationId ?? "");
  if (!conversationId) throw new HttpError(400, "Which conversation?");

  // Membership checked even for an ephemeral event: without it, anyone with the
  // `chat` capability could probe which conversation ids exist.
  await assertMember(conversationId, user.id);
  await requireWithinLimit("chat.typing", user.id);

  await publishToConversation(
    conversationId,
    "typing.start",
    { conversationId, userId: user.id },
    // Excluded from its own event — a composer does not need to be told that it
    // is typing.
    { socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true });
});
