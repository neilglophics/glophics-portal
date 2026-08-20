import crypto from "node:crypto";
import { sql } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * Pusher's presence webhook, used to persist "last seen".
 *
 * ── Why a webhook rather than a client heartbeat ──
 *
 * The moment last-seen actually matters is the moment the tab is gone, so a
 * client cannot be the one to report it. Pusher already knows when a member
 * leaves; this is one write per genuine connect/disconnect instead of a request
 * per user per interval, and it keeps working after the laptop closes.
 *
 * ── Signature verification is not optional ──
 *
 * This is a public URL with no session. Without verification anyone could POST a
 * member_removed for any id and rewrite when colleagues were last seen. Pusher
 * signs the raw body with the app secret as HMAC-SHA256 in X-Pusher-Signature,
 * so the RAW TEXT is read — not a parsed-and-restringified object, which would
 * not match byte for byte.
 *
 * Configured in the Pusher dashboard: add a webhook for "Presence" pointing at
 * /api/pusher/webhook.
 */

interface PusherEvent {
  name: string;
  channel: string;
  user_id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.PUSHER_SECRET;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;

  if (!secret || !key) {
    // Nothing to verify against, so nothing is trusted.
    return new Response("Not configured", { status: 503 });
  }

  const signature = req.headers.get("x-pusher-signature");
  const sentKey = req.headers.get("x-pusher-key");
  if (!signature || sentKey !== key) {
    return new Response("Forbidden", { status: 403 });
  }

  const raw = await req.text();
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  // Both are hex of a fixed length, but the incoming one is attacker-controlled,
  // so compare in constant time and guard the length first — timingSafeEqual
  // throws on a mismatch.
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn("[pusher-webhook] rejected a request with a bad signature");
    return new Response("Forbidden", { status: 403 });
  }

  let events: PusherEvent[] = [];
  try {
    events = (JSON.parse(raw) as { events?: PusherEvent[] }).events ?? [];
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  // Both directions touch last_seen_at: joining sets it so somebody who is
  // online right now has a sensible value if the leave event is ever missed.
  const ids = new Set(
    events
      .filter((e) => e.name === "member_added" || e.name === "member_removed")
      .map((e) => e.user_id)
      .filter((id): id is string => !!id && UUID.test(id)),
  );

  if (ids.size) {
    await sql`
      UPDATE auth_users SET last_seen_at = now() WHERE id = ANY(${[...ids]}::uuid[])
    `;
  }

  // 200 regardless of whether anything matched: a retry would not change the
  // outcome, and Pusher backing off on a webhook it cannot deliver is worse than
  // one ignored event.
  return Response.json({ ok: true, touched: ids.size });
}
