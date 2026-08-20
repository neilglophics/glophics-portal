/**
 * Checks the Pusher presence webhook.  npm run verify:presence
 *
 * This endpoint is public — no session, no cookie — and it WRITES to auth_users.
 * The only thing standing between it and anyone on the internet is an HMAC of the
 * raw body, so that is what these assertions are about: an unsigned, wrongly
 * signed, or wrong-key request must change nothing.
 *
 * ⚠ Needs a dev server and writes to DATABASE_URL. Creates a temporary login and
 * removes it in a finally block.
 */

import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));
const BASE = process.env.VERIFY_BASE ?? "http://localhost:3000";
const SECRET = process.env.PUSHER_SECRET ?? "";
const KEY = process.env.NEXT_PUBLIC_PUSHER_KEY ?? "";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
};

let userId: string | null = null;

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}/api/pusher/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

const sign = (body: string, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const lastSeen = async () => {
  const rows = (await sql`
    SELECT last_seen_at FROM auth_users WHERE id = ${userId}
  `) as { last_seen_at: string | null }[];
  return rows[0]?.last_seen_at ?? null;
};

try {
  if (!(await fetch(`${BASE}/login`, { redirect: "manual" }).catch(() => null))) {
    console.error(`\nNo server at ${BASE}. Start it with \`npm run dev\`.\n`);
    process.exit(1);
  }
  if (!SECRET || !KEY) {
    console.error("\nPUSHER_SECRET / NEXT_PUBLIC_PUSHER_KEY are not set, so there is nothing to verify against.\n");
    process.exit(1);
  }

  const salt = crypto.randomBytes(8).toString("hex");
  const rows = (await sql`
    INSERT INTO auth_users (username, display_name, role, salt, hash)
    VALUES (${`__vfyp_${salt.slice(0, 6)}`}, 'Verify Presence', 'member', ${salt}, 'x')
    RETURNING id
  `) as { id: string }[];
  userId = rows[0]!.id;

  check("a fresh login has no last_seen_at", (await lastSeen()) === null);

  const body = JSON.stringify({
    time_ms: Date.now(),
    events: [{ name: "member_removed", channel: "presence-org", user_id: userId }],
  });

  // ---- forgeries must change nothing ----
  const unsigned = await post(body, {});
  check("an UNSIGNED request is refused", unsigned.status === 403, `got ${unsigned.status}`);
  check("  and wrote nothing", (await lastSeen()) === null);

  const wrongSig = await post(body, { "x-pusher-key": KEY, "x-pusher-signature": "deadbeef" });
  check("a BAD signature is refused", wrongSig.status === 403, `got ${wrongSig.status}`);
  check("  and wrote nothing", (await lastSeen()) === null);

  const wrongSecret = await post(body, {
    "x-pusher-key": KEY,
    "x-pusher-signature": sign(body, "not-the-secret"),
  });
  check("a signature from the WRONG SECRET is refused", wrongSecret.status === 403,
    `got ${wrongSecret.status}`);
  check("  and wrote nothing", (await lastSeen()) === null);

  const wrongKey = await post(body, { "x-pusher-key": "someone-elses-key", "x-pusher-signature": sign(body) });
  check("a request with the WRONG APP KEY is refused", wrongKey.status === 403, `got ${wrongKey.status}`);

  // A correct signature over DIFFERENT bytes — proves the HMAC covers the body,
  // not just the presence of a header.
  const tampered = await post(
    JSON.stringify({ events: [{ name: "member_removed", channel: "presence-org", user_id: userId }] }),
    { "x-pusher-key": KEY, "x-pusher-signature": sign(body) },
  );
  check("a signature that does not match THESE bytes is refused", tampered.status === 403,
    `got ${tampered.status}`);
  check("  and wrote nothing", (await lastSeen()) === null);

  // ---- the genuine article ----
  const good = await post(body, { "x-pusher-key": KEY, "x-pusher-signature": sign(body) });
  check("a correctly signed request is accepted", good.status === 200, `got ${good.status}: ${good.text}`);
  const after = await lastSeen();
  check("and last_seen_at is now set", after !== null, String(after));

  // ---- a made-up user id is ignored, not an error ----
  const strangerBody = JSON.stringify({
    events: [{ name: "member_removed", channel: "presence-org", user_id: "not-a-uuid" }],
  });
  const stranger = await post(strangerBody, {
    "x-pusher-key": KEY,
    "x-pusher-signature": sign(strangerBody),
  });
  check("a non-uuid user id is ignored rather than erroring", stranger.status === 200,
    `got ${stranger.status}`);
  check("  and touched nobody", JSON.parse(stranger.text).touched === 0, stranger.text);
} catch (err) {
  fail += 1;
  console.log(`\n  THREW  ${(err as Error).stack ?? String(err)}`);
} finally {
  if (userId) await sql`DELETE FROM auth_users WHERE id = ${userId}`;
  const left = (await sql`
    SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfyp_%'`) as { n: number }[];
  console.log(`\ncleanup: temp login removed, ${left[0]!.n} left behind`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
