/**
 * The fan-out for a group change, in one place.
 *
 * Server-only — it reaches lib/realtime/server.ts, which holds PUSHER_SECRET.
 *
 * ── Why this is not five copies in five route handlers ──
 *
 * A rename, an avatar change, an add, a removal and a role change all publish the
 * same four things, and getting one of them wrong is invisible until somebody
 * notices their badge is off by one or a removed member's tab is still listening.
 * The four:
 *
 *   1. the system message, as an ordinary `message.new`, so the thread renders it
 *      through exactly the path every other message takes;
 *   2. `members.changed`, so open threads refetch the member list — which is what
 *      the UI's own permission checks read from;
 *   3. `unread.changed` per remaining member, because the unread count is DERIVED
 *      from the read watermark and a system message is a message. Skip this and
 *      the live badge silently disagrees with the next server render;
 *   4. `conversation.removed` to anyone who just left, on their own channel —
 *      they are off the conversation channel by the time this runs, so nothing
 *      published there can reach them.
 *
 * Publishing happens after the transaction has committed, as everywhere else. A
 * failed publish never fails the request; see the header of lib/realtime/server.ts.
 */

import {
  conversationUnread,
  notificationTargets,
  totalUnread,
  type MessageRow,
} from "@/lib/db/queries/chat";
import {
  publishBatch,
  publishToConversation,
  publishToUser,
  userChannel,
} from "@/lib/realtime/server";

export interface GroupChangePublish {
  conversationId: string;
  actorId: string;
  /**
   * Every line written by this change, oldest first. Usually one; an add of three
   * people is three, because each person's arrival is its own fact.
   */
  systemMessages: MessageRow[];
  /** Somebody who is no longer a member, if this change removed one. */
  departedUserId?: string | null;
  socketId?: string | null;
  /** Sent when the group's name or photo changed, so the header can repaint
   *  without waiting for a refresh. */
  updated?: { title: string | null; avatarVersion: string | null };
}

export async function publishGroupChange(input: GroupChangePublish): Promise<void> {
  const { conversationId, actorId, systemMessages, socketId = null } = input;

  for (const message of systemMessages) {
    await publishToConversation(conversationId, "message.new", message, { socketId });
  }

  if (input.updated) {
    await publishToConversation(
      conversationId,
      "conversation.updated",
      { conversationId, ...input.updated },
      { socketId },
    );
  }

  // Not excluded by socketId, deliberately: the acting tab needs the refetch too.
  // It knows a member changed but not what the row now looks like — a demotion it
  // just performed still has to redraw its own buttons.
  await publishToConversation(conversationId, "members.changed", { conversationId });

  if (input.departedUserId) {
    await publishToUser(input.departedUserId, "conversation.removed", { conversationId });
  }

  // The newest line is what a badge or a toast should describe.
  const newest = systemMessages[systemMessages.length - 1];
  if (!newest) return;

  // Muted members are excluded by this query rather than filtered afterwards, so
  // a muted group costs no Pusher message at all.
  const targets = await notificationTargets(conversationId, actorId);
  if (!targets.recipients.length) return;

  const items = await Promise.all(
    targets.recipients.map(async (memberId) => ({
      channel: userChannel(memberId),
      name: "unread.changed",
      data: {
        conversationId,
        conversationTitle: targets.title ?? "Group",
        // Null rather than the actor's name: a system message already begins
        // with who did it, and "Alex: Alex added Jamie" is a toast that reads
        // like a bug.
        senderName: null,
        preview: newest.body.slice(0, 140),
        unreadCount: await conversationUnread(conversationId, memberId),
        totalUnread: await totalUnread(memberId),
      },
    })),
  );

  await publishBatch(items);
}
