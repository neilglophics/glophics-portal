/**
 * Publishing. Server-only — this module holds PUSHER_SECRET and must never be
 * imported from a client component.
 *
 * ── Two properties that matter more than they look ──
 *
 * 1. UNCONFIGURED IS A SUPPORTED STATE. With no Pusher credentials every publish
 *    is a silent no-op and the app behaves exactly as it did before realtime
 *    existed: mutations still succeed, pages still revalidate for the acting tab.
 *    Realtime is an enhancement, not a dependency, so a missing env var must not
 *    turn a working board into a 500.
 *
 * 2. A FAILED PUBLISH NEVER FAILS THE REQUEST. The write is already committed by
 *    the time we get here. Throwing would tell the caller their claim failed
 *    when it did not — far worse than other tabs being briefly stale, which a
 *    reconnect or a navigation fixes anyway.
 *
 * Publishing happens AFTER the transaction commits, never inside it. If a
 * transaction rolled back after Pusher had been told, every client would render
 * something the database does not have.
 */

import Pusher from "pusher";
import { BOARD_CHANNEL, conversationChannel, userChannel } from "./channels";
import type { BoardEvents, ConversationEvents, UserEvents } from "./events";

let client: Pusher | null = null;
let checked = false;

function pusher(): Pusher | null {
  if (checked) return client;
  checked = true;

  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

  if (!appId || !key || !secret || !cluster) {
    console.warn("[realtime] Pusher is not configured — live updates are off, everything else works.");
    return null;
  }

  client = new Pusher({ appId, key, secret, cluster, useTLS: true });
  return client;
}

export function isRealtimeConfigured(): boolean {
  return pusher() !== null;
}

/** The server side of `/api/pusher/auth`. Null when unconfigured, so the route
 *  can answer 503 rather than pretending to authorize. */
export function authorize(
  socketId: string,
  channel: string,
  presenceData?: { user_id: string; user_info: Record<string, unknown> },
): { auth: string } | null {
  const instance = pusher();
  if (!instance) return null;

  return presenceData
    ? instance.authorizeChannel(socketId, channel, presenceData)
    : instance.authorizeChannel(socketId, channel);
}

interface PublishOptions {
  /**
   * The acting client's Pusher socket id, so Pusher excludes it from the fan-out.
   *
   * Without this the sender receives its own event and refreshes twice — once
   * from its own response, once from the echo. One field removes the whole class
   * of problem.
   */
  socketId?: string | null;
}

async function send(channel: string, event: string, payload: unknown, options?: PublishOptions) {
  const instance = pusher();
  if (!instance) return;

  try {
    await instance.trigger(channel, event, payload, {
      ...(options?.socketId ? { socket_id: options.socketId } : {}),
    });
  } catch (err) {
    // Logged, never rethrown. See the note at the top of this file.
    console.error(`[realtime] failed to publish ${event} on ${channel}:`, (err as Error).message);
  }
}

/** A board change, to everyone watching the board. */
export async function publishBoard<E extends keyof BoardEvents>(
  event: E,
  payload: BoardEvents[E],
  options?: PublishOptions,
): Promise<void> {
  await send(BOARD_CHANNEL, event, payload, options);
}

/** Something only one person should hear about. */
export async function publishToUser<E extends keyof UserEvents>(
  userId: string,
  event: E,
  payload: UserEvents[E],
  options?: PublishOptions,
): Promise<void> {
  await send(userChannel(userId), event, payload, options);
}

/**
 * Something only a conversation's members should hear about.
 *
 * Safe to call with member data because the channel itself is gated: nobody can
 * subscribe to `private-conv-<id>` without a chat_members row, checked by
 * /api/pusher/auth. That check is the reason this function can carry a message
 * body at all.
 */
export async function publishToConversation<E extends keyof ConversationEvents>(
  conversationId: string,
  event: E,
  payload: ConversationEvents[E],
  options?: PublishOptions,
): Promise<void> {
  await send(conversationChannel(conversationId), event, payload, options);
}

/**
 * Several publishes in one API call rather than one round trip each.
 *
 * The case this exists for is `unread.changed`, which goes to every non-sender
 * in a conversation: a ten-person group would otherwise multiply every message
 * by ten separate calls. Pusher accepts up to 10 events per batch (*verify*), so
 * this chunks.
 */
export async function publishBatch(
  items: { channel: string; name: string; data: unknown }[],
  options?: PublishOptions,
): Promise<void> {
  const instance = pusher();
  if (!instance || !items.length) return;

  const CHUNK = 10;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((item) => ({
      channel: item.channel,
      name: item.name,
      data: item.data,
      ...(options?.socketId ? { socket_id: options.socketId } : {}),
    }));

    try {
      await instance.triggerBatch(chunk);
    } catch (err) {
      console.error("[realtime] failed to publish batch:", (err as Error).message);
    }
  }
}

/** Channel-name builders, re-exported so route handlers building a batch do not
 *  have to import from two modules. */
export { conversationChannel, userChannel } from "./channels";

/**
 * Reads the acting client's socket id off a request.
 *
 * Sent as a header rather than in the body so it works for DELETE routes, which
 * have no body to put it in.
 */
export function socketIdFrom(req: Request): string | null {
  const id = req.headers.get("x-pusher-socket-id");
  // Pusher socket ids look like "123456.7890123". Validated because it is
  // attacker-controlled and goes into an API call.
  return id && /^\d+\.\d+$/.test(id) ? id : null;
}
