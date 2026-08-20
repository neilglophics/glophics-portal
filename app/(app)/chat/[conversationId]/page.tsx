import { notFound } from "next/navigation";
import { Thread } from "@/components/chat/Thread";
import { requireUser } from "@/lib/auth/require";
import { HttpError } from "@/lib/auth/require";
import { conversationReadState, listConversations, listMessages } from "@/lib/db/queries/chat";

/**
 * One conversation, server-rendered once and then owned by the client.
 *
 * The first page of messages is rendered on the server so the thread is readable
 * immediately and survives a reload — no loading spinner, and the browser's own
 * back/forward restores a real thread rather than an empty shell. From then on
 * Thread manages its own list; see the note at the top of that component.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  try {
    const user = await requireUser("chat");
    const found = (await listConversations(user.id)).find((c) => c.id === conversationId);
    return { title: found ? `${found.title} · Chat` : "Chat · Glophics Portal" };
  } catch {
    return { title: "Chat · Glophics Portal" };
  }
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const user = await requireUser("chat");
  const { conversationId } = await params;

  // Read from the viewer's own conversation list rather than fetching the row by
  // id: the list is already filtered by membership, so a conversation the viewer
  // is not in simply is not there. No separate authorization step to forget.
  const conversation = (await listConversations(user.id)).find((c) => c.id === conversationId);
  if (!conversation) notFound();

  let initial;
  let readUpTo: Record<string, number> = {};
  try {
    [initial, readUpTo] = await Promise.all([
      listMessages(conversationId, user.id, {}),
      conversationReadState(conversationId, user.id),
    ]);
  } catch (err) {
    // assertMember answers 404 for a non-member. Belt and braces — the list
    // lookup above has already established membership.
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }

  return (
    <Thread
      conversationId={conversationId}
      title={conversation.title}
      members={conversation.members}
      viewerId={user.id}
      // The query returns newest-first for pagination; the thread reads
      // oldest-first, so it is reversed once here rather than in the client.
      initialMessages={[...initial.messages].reverse()}
      initialHasMore={initial.hasMore}
      initialReadUpTo={readUpTo}
    />
  );
}
