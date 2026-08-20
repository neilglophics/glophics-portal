import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import {
  createGroup,
  listConversations,
  messageableUsers,
  openDirectMessage,
} from "@/lib/db/queries/chat";
import { requireWithinLimit } from "@/lib/rate-limit";
import { publishToUser, socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * The viewer's conversations, plus who they could start one with.
 *
 * Both are scoped to the caller: listConversations joins chat_members on the
 * viewer's id, so there is no shape of this request that returns a conversation
 * they are not in.
 */
export const GET = withApi(async () => {
  const user = await requireUser("chat");

  const [conversations, people] = await Promise.all([
    listConversations(user.id),
    messageableUsers(user.id),
  ]);

  return Response.json({ ok: true, conversations, people });
});

interface CreateBody {
  kind?: "dm" | "group";
  /** dm */
  userId?: string;
  /** group */
  title?: string;
  memberIds?: string[];
}

/**
 * Opens a DM or creates a group.
 *
 * A DM is idempotent: asking for one that exists returns it rather than erroring,
 * because "open the conversation with Sem" is the user's actual intent whether or
 * not it has been opened before. The uniqueness is enforced by the database, not
 * by checking first — see openDirectMessage().
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser("chat");
  await requireWithinLimit("chat.conversation.create", user.id);

  const body = await readJson<CreateBody>(req);

  if (body.kind === "group") {
    const { id, members } = await createGroup(
      user.id,
      String(body.title ?? ""),
      Array.isArray(body.memberIds) ? body.memberIds.map(String) : [],
    );

    // Everyone except the creator is told to go and subscribe.
    for (const memberId of members.filter((m) => m !== user.id)) {
      await publishToUser(memberId, "conversation.added", { conversationId: id });
    }

    return Response.json({ ok: true, id, created: true });
  }

  if (!body.userId) throw new HttpError(400, "Who do you want to message?");

  const { id, created } = await openDirectMessage(user.id, String(body.userId));

  // Only on first creation — reopening an existing DM is not news.
  if (created) {
    await publishToUser(String(body.userId), "conversation.added", { conversationId: id });
  }

  return Response.json({ ok: true, id, created, socketId: socketIdFrom(req) ? true : undefined });
});
