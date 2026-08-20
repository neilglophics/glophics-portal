/**
 * Channel names, and the parser that decides what a name even means.
 *
 * The `presence-` and `private-` prefixes are not a convention — they are the
 * mechanism Pusher uses to select its authorization behaviour. A channel without
 * one is public: anyone holding the app key (which ships in the browser bundle,
 * by design) could subscribe. So nothing in this app is public, including the
 * board.
 *
 * ── Why the parser returns a union and never a fallback ──
 *
 * `parseChannel` is the first half of the most security-critical path in the
 * codebase. It is DEFAULT DENY: an unrecognised shape returns null, and
 * /api/pusher/auth refuses. It must never grow a branch that says "probably fine".
 *
 * The subtlety worth naming: `private-user-<id>` is compared by EXACT id, not by
 * prefix. A `startsWith` test would let `private-user-abc` authorize
 * `private-user-abcd` — a different person's notification channel.
 */

/** Postgres gen_random_uuid() output. Anything else is not one of our ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BOARD_CHANNEL = "private-board";
export const ORG_PRESENCE_CHANNEL = "presence-org";

export const userChannel = (authUserId: string) => `private-user-${authUserId}`;
export const conversationChannel = (conversationId: string) => `private-conv-${conversationId}`;

export type Channel =
  | { kind: "board" }
  | { kind: "presence" }
  | { kind: "user"; userId: string }
  | { kind: "conversation"; conversationId: string };

/**
 * A channel name to what it refers to, or null when the name is not one this app
 * issues. Null means refuse — never "allow with reduced privileges".
 */
export function parseChannel(name: string): Channel | null {
  if (name === BOARD_CHANNEL) return { kind: "board" };
  if (name === ORG_PRESENCE_CHANNEL) return { kind: "presence" };

  const user = /^private-user-(.+)$/.exec(name);
  if (user) {
    const id = user[1]!;
    // Validated, so a crafted name cannot smuggle a wildcard or a path segment
    // into whatever compares it downstream.
    return UUID.test(id) ? { kind: "user", userId: id } : null;
  }

  const conv = /^private-conv-(.+)$/.exec(name);
  if (conv) {
    const id = conv[1]!;
    return UUID.test(id) ? { kind: "conversation", conversationId: id } : null;
  }

  return null;
}
