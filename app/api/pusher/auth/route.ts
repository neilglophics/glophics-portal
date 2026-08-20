import { withApi } from "@/lib/auth/require";
import { getCurrentUser } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { parseChannel } from "@/lib/realtime/channels";
import { authorize, isRealtimeConfigured } from "@/lib/realtime/server";
import { roleCan } from "@/lib/shared/roles";

export const runtime = "nodejs";

/**
 * Subscription authorization. THE security boundary for everything realtime.
 *
 * A bug here hands live private messages to a subscriber, and no amount of
 * correct SQL elsewhere would catch it. So:
 *
 *   - DEFAULT DENY. parseChannel returns a union; an unrecognised name is
 *     refused. There is no fallback branch.
 *   - `private-user-<id>` is an EXACT id comparison, never a prefix test.
 *   - `private-conv-<id>` requires a row in chat_members. A superadmin gets no
 *     implicit bypass: if admins are ever meant to read any conversation, that
 *     is a product decision (docs/06-OPEN-QUESTIONS.md Q5) belonging in an
 *     explicit, logged code path — not a silent exception here.
 *   - Presence data carries only what other members may see. Everything in
 *     `user_info` is broadcast to every other presence member, so no username,
 *     no email, no session detail.
 *
 * Answers 403 rather than 401 for a caller whose cookie does not resolve, so
 * nothing downstream mistakes a failed subscription for "go and sign in".
 *
 * With no cookie at all, middleware answers 401 before this handler runs. That
 * is fine — pusher-js treats any non-200 as a failed subscription — and it only
 * happens in a state where the page itself has already been redirected to
 * /login. The case this handler actually sees is the interesting one: a cookie
 * that is present but dead.
 */
export const POST = withApi(async (req: Request) => {
  if (!isRealtimeConfigured()) {
    // Honest rather than silently unauthorized — the client shows "offline"
    // instead of retrying against something that can never answer.
    return Response.json({ ok: false, error: "Realtime is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ ok: false, error: "Not signed in." }, { status: 403 });
  }

  // pusher-js posts these as form-encoded, not JSON.
  const form = await req.formData().catch(() => null);
  const socketId = String(form?.get("socket_id") ?? "");
  const channelName = String(form?.get("channel_name") ?? "");

  if (!/^\d+\.\d+$/.test(socketId) || !channelName) {
    return Response.json({ ok: false, error: "Bad subscription request." }, { status: 400 });
  }

  const channel = parseChannel(channelName);
  if (!channel) {
    console.warn(`[pusher-auth] refused unknown channel "${channelName}" for @${user.username}`);
    return Response.json({ ok: false, error: "Unknown channel." }, { status: 403 });
  }

  switch (channel.kind) {
    case "board": {
      if (!roleCan(user.role, "view")) {
        return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
      }
      const auth = authorize(socketId, channelName);
      return auth ? Response.json(auth) : Response.json({ ok: false }, { status: 503 });
    }

    case "user": {
      // Exact match. A prefix test would let private-user-abc authorize
      // private-user-abcd — somebody else's channel.
      if (channel.userId !== user.id) {
        console.warn(`[pusher-auth] @${user.username} tried to subscribe to another user's channel`);
        return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
      }
      const auth = authorize(socketId, channelName);
      return auth ? Response.json(auth) : Response.json({ ok: false }, { status: 503 });
    }

    case "presence": {
      if (!roleCan(user.role, "chat")) {
        return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
      }
      const auth = authorize(socketId, channelName, {
        user_id: user.id,
        // Only what other members may see.
        user_info: { displayName: user.displayName, role: user.role },
      });
      return auth ? Response.json(auth) : Response.json({ ok: false }, { status: 503 });
    }

    case "conversation": {
      if (!roleCan(user.role, "chat")) {
        return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
      }
      // Membership IS the authorization. Until chat exists there are no rows, so
      // this correctly refuses everything.
      const member = (await sql`
        SELECT 1 FROM chat_members
         WHERE conversation_id = ${channel.conversationId} AND user_id = ${user.id}
         LIMIT 1
      `) as unknown[];

      if (!member.length) {
        console.warn(`[pusher-auth] @${user.username} is not a member of ${channel.conversationId}`);
        return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
      }
      const auth = authorize(socketId, channelName);
      return auth ? Response.json(auth) : Response.json({ ok: false }, { status: 503 });
    }
  }
});
