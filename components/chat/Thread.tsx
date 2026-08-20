"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useRealtime } from "@/components/providers/PusherProvider";
import { usePresence } from "@/components/providers/PresenceProvider";
import { conversationChannel } from "@/lib/realtime/channels";
import { getPusher, realtimeHeaders } from "@/lib/realtime/client";
import { dropConfirmedPending, mergeMessages } from "@/lib/chat/merge";
import { formatDateTime } from "@/lib/shared/format";
import type { MessageRow } from "@/lib/db/queries/chat";

/**
 * One conversation.
 *
 * ── Why this component owns its state ──
 *
 * Everything else in this app renders from Postgres in a Server Component and
 * repaints via router.refresh(). A message list cannot: refetching a paginated
 * thread on every incoming message is slow, and re-rendering it wholesale
 * destroys scroll position, text selection, and whatever is half-typed in the
 * composer. So this holds an append-only list of its own.
 *
 * The server's data is still authoritative. `initialMessages` is MERGED in when
 * it changes rather than ignored, so a refresh can only ever add — it cannot
 * erase something already on screen.
 *
 * ── Sent messages arrive from the POST, not from the event ──
 *
 * Mutations send this tab's socket id, so Pusher excludes it from its own
 * fan-out. That is deliberate (no echo, no double render), and it means the
 * sender must reconcile from its own response. Everyone else gets `message.new`.
 */

interface Pending {
  clientMsgId: string;
  body: string;
  failed: boolean;
}

interface Member {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
}

const TYPING_PING_MS = 3000;
const TYPING_EXPIRY_MS = 4000;
/** Treat "within this many pixels of the bottom" as being at the bottom. */
const STICK_THRESHOLD_PX = 120;

export function Thread({
  conversationId,
  title,
  members,
  viewerId,
  initialMessages,
  initialHasMore,
  initialReadUpTo,
}: {
  conversationId: string;
  title: string;
  members: Member[];
  viewerId: string;
  initialMessages: MessageRow[];
  initialHasMore: boolean;
  /** Each other member's last-read message id, from chat_members. */
  initialReadUpTo: Record<string, number>;
}) {
  const { state: connectionState } = useRealtime();
  const { online, tracking } = usePresence();

  const [confirmed, setConfirmed] = useState<MessageRow[]>(initialMessages);
  const [pending, setPending] = useState<Pending[]>([]);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState<Record<string, number>>({});
  /**
   * Each member's read position. A watermark per person, not a receipt per
   * message (ADR-006) — so "read" is answered by comparing one number against a
   * message id rather than by looking up a row.
   */
  const [readUpTo, setReadUpTo] = useState<Record<string, number>>(initialReadUpTo);
  const [missed, setMissed] = useState(0);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastTypingPing = useRef(0);
  const readReported = useRef(0);
  const hasConnected = useRef(false);

  const dmPartner = members.length === 2 ? members.find((m) => m.id !== viewerId) : undefined;

  // The newest message the viewer sent — the only one that carries a receipt.
  const lastMineId = confirmed.reduce(
    (best, m) => (m.senderId === viewerId && m.id > best ? m.id : best),
    0,
  );

  const newestId = confirmed.length ? confirmed[confirmed.length - 1]!.id : 0;
  const oldestId = confirmed.length ? confirmed[0]!.id : 0;

  const memberName = useCallback(
    (id: string | null) => members.find((m) => m.id === id)?.displayName ?? "Former member",
    [members],
  );

  const memberFace = useCallback(
    (id: string | null) => members.find((m) => m.id === id)?.avatarUrl ?? null,
    [members],
  );

  // The server's copy can only add. Never replaces, so nothing on screen
  // disappears because a refresh happened to race a send.
  useEffect(() => {
    setConfirmed((prev) => mergeMessages(prev, initialMessages));
    // A refresh can land before this tab's own POST resolves, in which case the
    // real row arrives here and the optimistic bubble must go with it — or the
    // message would briefly show twice.
    setPending((prev) => dropConfirmedPending(prev, initialMessages));
  }, [initialMessages]);

  // ---------- scrolling ----------

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [conversationId, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < STICK_THRESHOLD_PX;
    if (atBottom.current) setMissed(0);
  }, []);

  /**
   * Follow new messages only if the reader was already at the bottom. Yanking
   * someone back down while they are reading history is worse than a subtle
   * "N new" affordance.
   */
  useEffect(() => {
    if (atBottom.current) scrollToBottom(true);
  }, [confirmed.length, pending.length, scrollToBottom]);

  // ---------- read watermark ----------

  useEffect(() => {
    if (!newestId || newestId <= readReported.current) return;
    if (!atBottom.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    const timer = setTimeout(() => {
      readReported.current = newestId;
      void fetch(`/api/chat/conversations/${conversationId}/read`, {
        method: "POST",
        headers: { ...realtimeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ lastReadMessageId: newestId }),
      }).catch(() => {
        // Reset so a later attempt retries rather than believing it reported.
        readReported.current = 0;
      });
    }, 600);

    return () => clearTimeout(timer);
  }, [conversationId, newestId]);

  // ---------- live events ----------

  useEffect(() => {
    const pusher = getPusher();
    if (!pusher) return;

    const channel = pusher.subscribe(conversationChannel(conversationId));

    const onMessage = (msg: MessageRow) => {
      setConfirmed((prev) => mergeMessages(prev, [msg]));
      // Somebody else typed it, so their typing indicator is now stale.
      setTyping((prev) => {
        if (!msg.senderId || !(msg.senderId in prev)) return prev;
        const next = { ...prev };
        delete next[msg.senderId];
        return next;
      });
      if (!atBottom.current) setMissed((n) => n + 1);
    };

    const onTyping = ({ userId }: { userId: string }) => {
      if (userId === viewerId) return;
      setTyping((prev) => ({ ...prev, [userId]: Date.now() }));
    };

    const onRead = ({ userId, lastReadMessageId }: { userId: string; lastReadMessageId: number }) => {
      // Monotonic, matching the server's GREATEST: an out-of-order event from a
      // second tab must not walk somebody's read position backwards.
      setReadUpTo((prev) =>
        (prev[userId] ?? 0) >= lastReadMessageId ? prev : { ...prev, [userId]: lastReadMessageId },
      );
    };

    channel.bind("message.new", onMessage);
    channel.bind("message.edited", onMessage);
    channel.bind("typing.start", onTyping);
    channel.bind("read.changed", onRead);

    return () => {
      channel.unbind("message.new", onMessage);
      channel.unbind("message.edited", onMessage);
      channel.unbind("typing.start", onTyping);
      channel.unbind("read.changed", onRead);
      pusher.unsubscribe(conversationChannel(conversationId));
    };
  }, [conversationId, viewerId]);

  /**
   * Catch-up. PUSHER DOES NOT REPLAY, so anything published while this tab was
   * disconnected is gone unless it is asked for. Because ids are a monotonic
   * bigserial, `after=<newest rendered>` is exact — no timestamp comparison and
   * no overlap window to de-duplicate.
   */
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (!hasConnected.current) {
      // First connect needs nothing: the server just rendered this thread.
      hasConnected.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/chat/conversations/${conversationId}/messages?after=${newestId}`,
      ).catch(() => null);
      const data = (await res?.json().catch(() => ({}))) as { messages?: MessageRow[] };
      if (!cancelled && data.messages?.length) {
        setConfirmed((prev) => mergeMessages(prev, data.messages!));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionState, conversationId, newestId]);

  // Expire typing indicators — there is no `typing.stop` by design.
  useEffect(() => {
    if (!Object.keys(typing).length) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - TYPING_EXPIRY_MS;
      setTyping((prev) => {
        const next = Object.fromEntries(Object.entries(prev).filter(([, at]) => at > cutoff));
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [typing]);

  // ---------- sending ----------

  const pingTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingPing.current < TYPING_PING_MS) return;
    lastTypingPing.current = now;

    void fetch("/api/chat/typing", {
      method: "POST",
      headers: { ...realtimeHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }).catch(() => {});
  }, [conversationId]);

  const send = useCallback(
    async (bodyText: string, existingClientMsgId?: string) => {
      const body = bodyText.trim();
      if (!body) return;

      // Generated here and reused on retry, so a resend cannot double-post: the
      // unique index on (conversation_id, client_msg_id) turns it into a no-op.
      const clientMsgId = existingClientMsgId ?? crypto.randomUUID();

      setPending((prev) =>
        existingClientMsgId
          ? prev.map((p) => (p.clientMsgId === clientMsgId ? { ...p, failed: false } : p))
          : [...prev, { clientMsgId, body, failed: false }],
      );
      setSending(true);
      atBottom.current = true;

      const res = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { ...realtimeHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientMsgId, body }),
      }).catch(() => null);

      const data = (await res?.json().catch(() => ({}))) as { ok?: boolean; message?: MessageRow };
      setSending(false);

      if (!res?.ok || !data.ok || !data.message) {
        setPending((prev) =>
          prev.map((p) => (p.clientMsgId === clientMsgId ? { ...p, failed: true } : p)),
        );
        return;
      }

      // This tab was excluded from the fan-out, so the response is where the
      // real row comes from.
      setConfirmed((prev) => mergeMessages(prev, [data.message!]));
      setPending((prev) => prev.filter((p) => p.clientMsgId !== clientMsgId));
    },
    [conversationId],
  );

  /** Clears the composer first, so a slow send does not leave the text sitting
   *  there looking unsent while the optimistic bubble is already below it. */
  const submitDraft = useCallback(() => {
    const body = draft;
    if (!body.trim()) return;
    setDraft("");
    void send(body);
  }, [draft, send]);

  // ---------- older pages ----------

  async function loadOlder() {
    if (loadingOlder || !oldestId) return;
    setLoadingOlder(true);

    const el = scroller.current;
    const heightBefore = el?.scrollHeight ?? 0;

    const res = await fetch(
      `/api/chat/conversations/${conversationId}/messages?before=${oldestId}`,
    ).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as {
      messages?: MessageRow[];
      hasMore?: boolean;
    };

    if (data.messages?.length) {
      setConfirmed((prev) => mergeMessages(prev, data.messages!));
      setHasMore(!!data.hasMore);
      // Keep the reader where they were rather than letting prepended content
      // shove the viewport down.
      requestAnimationFrame(() => {
        const after = scroller.current;
        if (after) after.scrollTop = after.scrollHeight - heightBefore;
      });
    } else {
      setHasMore(false);
    }
    setLoadingOlder(false);
  }

  // ---------- render ----------

  const typingNames = useMemo(
    () => Object.keys(typing).map(memberName),
    [typing, memberName],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <Avatar
          person={{
            id: conversationId,
            name: title,
            avatarUrl: dmPartner?.avatarUrl ?? null,
          }}
          size="h-9 w-9"
          online={tracking && dmPartner ? online.has(dmPartner.id) : undefined}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{title}</p>
          <p className="truncate text-[11px] text-faint">
            {dmPartner
              ? tracking
                ? online.has(dmPartner.id)
                  ? "Online"
                  : "Offline"
                : `${members.length} members`
              : `${members.length} member${members.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {hasMore ? (
          <div className="pb-4 text-center">
            <Button size="sm" variant="quiet" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older messages"}
            </Button>
          </div>
        ) : null}

        {!confirmed.length && !pending.length ? (
          <p className="py-12 text-center text-xs text-faint">
            No messages yet. Say something.
          </p>
        ) : null}

        <div className="space-y-2.5">
          {confirmed.map((m) => (
            <Bubble
              key={m.id}
              // Only on the newest message you sent: a tick under every line is
              // noise, and the last one answers the actual question.
              readBy={
                m.senderId === viewerId && m.id === lastMineId
                  ? members
                      .filter((x) => x.id !== viewerId && (readUpTo[x.id] ?? 0) >= m.id)
                      .map((x) => x.displayName)
                  : undefined
              }
              mine={m.senderId === viewerId}
              author={memberName(m.senderId)}
              authorId={m.senderId}
              authorFace={memberFace(m.senderId)}
              body={m.body}
              at={m.createdAt}
              deleted={!!m.deletedAt}
            />
          ))}

          {pending.map((p) => (
            <Bubble
              key={p.clientMsgId}
              mine
              author=""
              body={p.body}
              at={null}
              state={p.failed ? "failed" : "sending"}
              onRetry={p.failed ? () => void send(p.body, p.clientMsgId) : undefined}
            />
          ))}
        </div>
      </div>

      {missed > 0 ? (
        <button
          type="button"
          onClick={() => {
            setMissed(0);
            atBottom.current = true;
            scrollToBottom(true);
          }}
          className="mx-auto -mt-2 mb-1 flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-on-accent shadow-lg"
        >
          {missed} new message{missed === 1 ? "" : "s"}
          <Icon name="chevron" className="h-3 w-3 rotate-90" />
        </button>
      ) : null}

      <div className="h-5 shrink-0 px-4">
        {typingNames.length ? (
          <p className="truncate text-[11px] italic text-faint">
            {typingNames.length === 1
              ? `${typingNames[0]} is typing…`
              : `${typingNames.length} people are typing…`}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitDraft();
        }}
        className="flex shrink-0 items-end gap-2 border-t border-line p-3"
      >
        <textarea
          value={draft}
          rows={1}
          placeholder="Write a message…"
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim()) pingTyping();
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. The usual contract, and the
            // one people will assume without being told.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitDraft();
            }
          }}
          className="max-h-32 min-h-[42px] flex-1 resize-y rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 placeholder:text-faintest focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft"
        />
        <Button type="submit" variant="dark" disabled={sending || !draft.trim()} className="shrink-0">
          Send
        </Button>
      </form>
    </div>
  );
}

/**
 * One message.
 *
 * `body` is a text child, so React escapes it. There is no
 * dangerouslySetInnerHTML here and there must not be: chat is the first place in
 * this app where one person's typing is rendered to another, and it is the whole
 * XSS surface. If link or markdown rendering is ever wanted, that is a sanitiser
 * decision, not a reason to hand raw HTML to the DOM.
 */
function Bubble({
  mine,
  author,
  authorId,
  authorFace,
  body,
  at,
  state,
  deleted,
  readBy,
  onRetry,
}: {
  mine: boolean;
  author: string;
  authorId?: string | null;
  authorFace?: string | null;
  body: string;
  at: string | null;
  state?: "sending" | "failed";
  deleted?: boolean;
  /** Names of the other members who have read this. Undefined on messages that
   *  carry no receipt, which is all of them except your latest. */
  readBy?: string[];
  onRetry?: () => void;
}) {
  return (
    <div className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
      {/* Only on the other side: your own face beside your own words is noise. */}
      {!mine && author ? (
        <Avatar person={{ id: authorId ?? author, name: author, avatarUrl: authorFace }} size="h-7 w-7" />
      ) : null}
      <div className={`max-w-[78%] ${mine ? "items-end" : "items-start"}`}>
        {!mine && author ? (
          <p className="mb-0.5 px-1 text-[10px] font-semibold text-faint">{author}</p>
        ) : null}

        <div
          className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
            deleted
              ? "bg-subtle-2 italic text-faint"
              : mine
                ? "bg-brand-500 text-white"
                : "bg-subtle text-ink-2"
          } ${state === "failed" ? "ring-1 ring-bad" : ""} ${state === "sending" ? "opacity-60" : ""}`}
        >
          {deleted ? "Message deleted" : <span className="whitespace-pre-wrap break-words">{body}</span>}
        </div>

        <div className={`mt-0.5 flex items-center gap-2 px-1 ${mine ? "justify-end" : ""}`}>
          {state === "failed" ? (
            <button
              type="button"
              onClick={onRetry}
              className="text-[10px] font-semibold text-bad hover:underline"
            >
              Failed — retry
            </button>
          ) : state === "sending" ? (
            <span className="text-[10px] text-faintest">Sending…</span>
          ) : at ? (
            <>
              <span className="text-[10px] text-faintest">{formatDateTime(at)}</span>
              {readBy ? (
                <span
                  className="text-[10px] font-medium text-brand-fg"
                  title={readBy.length ? `Read by ${readBy.join(", ")}` : "Not read yet"}
                >
                  {readBy.length
                    ? readBy.length === 1
                      ? `Read by ${readBy[0]}`
                      : `Read by ${readBy.length}`
                    : "Sent"}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
