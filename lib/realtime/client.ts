"use client";

import Pusher from "pusher-js";

/**
 * The browser's single Pusher connection.
 *
 * ── Why a module-scope singleton and not a ref ──
 *
 * React Strict Mode double-invokes effects in development, and Fast Refresh
 * remounts on every save. Creating the client inside an effect without a guard
 * leaks a connection each time, and the concurrent-connection quota is reached
 * while you are still building the feature — which then looks like a Pusher
 * problem rather than a lifecycle one.
 *
 * The socket id lives here too, rather than only in context, so the mutation
 * helpers can attach it to a fetch without every action component having to
 * consume a hook.
 */

let client: Pusher | null = null;
let socketId: string | null = null;

export function realtimeEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_PUSHER_KEY && !!process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
}

export function getPusher(): Pusher | null {
  if (!realtimeEnabled()) return null;
  if (client) return client;

  client = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
    // The app key is public by design and ships in this bundle. Authorization
    // comes from this endpoint, never from the key being secret.
    authEndpoint: "/api/pusher/auth",
    forceTLS: true,
  });

  client.connection.bind("connected", () => {
    socketId = client?.connection.socket_id ?? null;
  });
  client.connection.bind("disconnected", () => {
    socketId = null;
  });

  return client;
}

export function currentSocketId(): string | null {
  return socketId;
}

/**
 * Headers to attach to a mutating fetch.
 *
 * Passing the socket id lets the server exclude this tab from the fan-out, so it
 * does not receive an echo of its own change and refresh twice.
 */
export function realtimeHeaders(): Record<string, string> {
  const id = currentSocketId();
  return id ? { "x-pusher-socket-id": id } : {};
}

export type ConnectionState =
  | "initialized"
  | "connecting"
  | "connected"
  | "unavailable"
  | "failed"
  | "disconnected";
