import { requireUser } from "@/lib/auth/require";
import { listConversations, messageableUsers } from "@/lib/db/queries/chat";
import { ConversationList } from "@/components/chat/ConversationList";

/**
 * Two panes: the conversation list, and whichever thread is open.
 *
 * A layout rather than part of each page, so navigating between conversations
 * does not remount the list — and, more importantly, does not remount the thread
 * component's own message state for the conversation you are already in.
 */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("chat");

  const [conversations, people] = await Promise.all([
    listConversations(user.id),
    messageableUsers(user.id),
  ]);

  return (
    <div className="flex h-full min-h-0 gap-0 px-4 pb-4 sm:px-6 lg:px-7">
      <div className="hidden w-72 shrink-0 md:block">
        <ConversationList conversations={conversations} people={people} />
      </div>
      <div className="min-w-0 flex-1 md:pl-4">{children}</div>
    </div>
  );
}
