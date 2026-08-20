"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { agoText } from "@/lib/shared/format";
import { NewConversationDialog } from "./NewConversationDialog";
import type { ConversationSummary } from "@/lib/db/queries/chat";

export interface Person {
  id: string;
  displayName: string;
  username: string;
  role: string;
}

/**
 * The conversation list. Server-rendered data, client component only so the open
 * conversation can be highlighted from the URL.
 *
 * Unread counts come from the server on each refresh rather than being tracked
 * here. They are derived from the read watermark (ADR-006), so the server's
 * answer is authoritative and a local counter could only drift from it.
 */
export function ConversationList({
  conversations,
  people,
}: {
  conversations: ConversationSummary[];
  people: Person[];
}) {
  const params = useParams<{ conversationId?: string }>();
  const activeId = params?.conversationId;
  const [composing, setComposing] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-bold tracking-tight">Chat</h2>
        <Button size="sm" variant="dark" onClick={() => setComposing(true)}>
          New
        </Button>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {conversations.length ? (
          conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                className={`mb-1 flex items-start gap-3 rounded-xl px-2.5 py-2.5 transition ${
                  active ? "bg-brand-soft" : "hover:bg-subtle"
                }`}
              >
                <Avatar person={{ id: c.id, name: c.title }} size="h-9 w-9" />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p
                      className={`min-w-0 flex-1 truncate text-sm ${
                        c.unreadCount ? "font-bold text-ink" : "font-semibold text-ink-2"
                      }`}
                    >
                      {c.title}
                    </p>
                    {c.lastMessageAt ? (
                      <span className="shrink-0 text-[10px] text-faint">{agoText(c.lastMessageAt)}</span>
                    ) : null}
                  </div>

                  <div className="mt-0.5 flex items-center gap-2">
                    <p
                      className={`min-w-0 flex-1 truncate text-[11px] ${
                        c.unreadCount ? "font-medium text-body" : "text-faint"
                      }`}
                    >
                      {c.lastMessagePreview ?? "No messages yet"}
                    </p>
                    {c.unreadCount ? (
                      <span className="shrink-0 rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {c.unreadCount > 99 ? "99+" : c.unreadCount}
                      </span>
                    ) : null}
                  </div>

                  {c.kind === "group" ? (
                    <p className="mt-1 truncate text-[10px] text-faintest">
                      {c.members.length} member{c.members.length === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </div>
              </Link>
            );
          })
        ) : (
          <div className="px-3 py-10 text-center">
            <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-subtle-2 text-faint">
              <Icon name="chat" className="h-5 w-5" />
            </span>
            <p className="mt-3 text-xs text-faint">No conversations yet.</p>
            <p className="mt-1 text-[11px] text-faintest">
              Only people with a login can be messaged.
            </p>
          </div>
        )}
      </div>

      {composing ? (
        <NewConversationDialog people={people} onClose={() => setComposing(false)} />
      ) : null}
    </div>
  );
}
