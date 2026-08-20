/**
 * End-to-end check of the chat HTTP surface.  npm run verify:chat:http
 *
 * verify-chat.mts exercises the query layer directly. This one goes over the
 * wire against a running dev server, which is the only way to prove the parts
 * that live in the route handlers rather than the queries: that `requireUser`
 * gates every endpoint, that a non-member gets 404 from the API and not just
 * from a function, and — the one that matters most — that /api/pusher/auth
 * refuses a hand-crafted subscription to somebody else's channel.
 *
 * It mints real sessions for two temporary users and deletes everything it made
 * in a finally block.
 *
 * ⚠ Needs a dev server on BASE (default http://localhost:3000) and writes to
 * whatever DATABASE_URL points at. Do not aim it at production.
 */

import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));
const BASE = process.env.VERIFY_BASE ?? "http://localhost:3000";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
}

const made: string[] = [];
const tokens: string[] = [];

/** A real session, created the same way lib/auth/session.ts does: a random
 *  token, with only its SHA-256 stored. */
async function mkSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await sql`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (${hash}, ${userId}, now() + interval '1 hour')
  `;
  tokens.push(hash);
  return token;
}

async function mkUser(tag: string, role = "member"): Promise<{ id: string; token: string }> {
  const salt = crypto.randomBytes(8).toString("hex");
  const rows = (await sql`
    INSERT INTO auth_users (username, display_name, role, salt, hash)
    VALUES (${`__vfyh_${tag}_${salt.slice(0, 6)}`}, ${`VerifyHttp ${tag}`}, ${role}, ${salt}, 'x')
    RETURNING id
  `) as { id: string }[];
  const id = rows[0]!.id;
  made.push(id);
  return { id, token: await mkSession(id) };
}

function api(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Cookie: `sm_session=${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    redirect: "manual",
  });
}

try {
  // Reachability first, so a stopped dev server reads as that and not as 20 failures.
  const ping = await fetch(`${BASE}/login`, { redirect: "manual" }).catch(() => null);
  if (!ping) {
    console.error(`\nNo server at ${BASE}. Start it with \`npm run dev\` and retry.\n`);
    process.exit(1);
  }

  const alice = await mkUser("a");
  const bob = await mkUser("b");
  const carol = await mkUser("c");
  const viewer = await mkUser("v", "viewer"); // no `chat` capability

  // ---- capability gate ----
  const viewerRes = await api(viewer.token, "/api/chat/conversations");
  check("a VIEWER is refused (no chat capability)", viewerRes.status === 403, `got ${viewerRes.status}`);

  const aliceList = await api(alice.token, "/api/chat/conversations");
  check("a member may list conversations", aliceList.status === 200, `got ${aliceList.status}`);

  // ---- open a DM ----
  const created = await api(alice.token, "/api/chat/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "dm", userId: bob.id }),
  });
  const createdBody = (await created.json()) as { ok?: boolean; id?: string };
  check("opening a DM succeeds", created.status === 200 && !!createdBody.id);
  const convId = createdBody.id!;

  const again = await api(bob.token, "/api/chat/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "dm", userId: alice.id }),
  });
  const againBody = (await again.json()) as { id?: string; created?: boolean };
  check("reopening from the other side returns the SAME id", againBody.id === convId);
  check("and reports created=false", againBody.created === false);

  // ---- send ----
  const send = await api(alice.token, `/api/chat/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({ clientMsgId: "http-1", body: "over the wire" }),
  });
  const sendBody = (await send.json()) as { ok?: boolean; created?: boolean; message?: { id: number } };
  check("sending works", send.status === 200 && sendBody.created === true);

  const retry = await api(alice.token, `/api/chat/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({ clientMsgId: "http-1", body: "over the wire" }),
  });
  const retryBody = (await retry.json()) as { created?: boolean; message?: { id: number } };
  check("a retry is idempotent over HTTP too", retryBody.created === false);
  check("and returns the same message id", retryBody.message?.id === sendBody.message?.id);

  // ---- XSS payload is stored and returned as TEXT ----
  const payload = `<img src=x onerror="alert(1)">`;
  await api(alice.token, `/api/chat/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({ clientMsgId: "xss-1", body: payload }),
  });
  const read = await api(bob.token, `/api/chat/conversations/${convId}/messages`);
  const readBody = (await read.json()) as { messages?: { body: string }[] };
  const stored = readBody.messages?.find((m) => m.body.includes("onerror"));
  check("an HTML payload is stored verbatim as text, not mangled", stored?.body === payload);

  // ---- membership boundary over HTTP ----
  const intrudeRead = await api(carol.token, `/api/chat/conversations/${convId}/messages`);
  check("a NON-MEMBER gets 404 reading", intrudeRead.status === 404, `got ${intrudeRead.status}`);

  const intrudeSend = await api(carol.token, `/api/chat/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({ clientMsgId: "x", body: "let me in" }),
  });
  check("a NON-MEMBER gets 404 sending", intrudeSend.status === 404, `got ${intrudeSend.status}`);

  const intrudeTyping = await api(carol.token, "/api/chat/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  check("a NON-MEMBER cannot even signal typing", intrudeTyping.status === 404);

  // ---- /api/pusher/auth: the subscription boundary ----
  const authFor = (token: string, channel: string) =>
    fetch(`${BASE}/api/pusher/auth`, {
      method: "POST",
      headers: { Cookie: `sm_session=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: `socket_id=123.456&channel_name=${encodeURIComponent(channel)}`,
      redirect: "manual",
    });

  const memberSub = await authFor(alice.token, `private-conv-${convId}`);
  check("a member may subscribe to the conversation", memberSub.status === 200, `got ${memberSub.status}`);

  const intruderSub = await authFor(carol.token, `private-conv-${convId}`);
  check("a NON-MEMBER cannot subscribe", intruderSub.status === 403, `got ${intruderSub.status}`);

  const othersChannel = await authFor(carol.token, `private-user-${alice.id}`);
  check("nobody can subscribe to another person's user channel", othersChannel.status === 403,
    `got ${othersChannel.status}`);

  const ownChannel = await authFor(carol.token, `private-user-${carol.id}`);
  check("but may subscribe to their own", ownChannel.status === 200, `got ${ownChannel.status}`);

  const prefix = await authFor(carol.token, `private-user-${carol.id.slice(0, 30)}`);
  check("a PREFIX of a real id is refused", prefix.status === 403, `got ${prefix.status}`);

  const madeUp = await authFor(alice.token, "private-something-else");
  check("an unknown channel shape is refused", madeUp.status === 403, `got ${madeUp.status}`);

  const publicish = await authFor(alice.token, "board");
  check("a public channel name is refused", publicish.status === 403, `got ${publicish.status}`);

  const viewerPresence = await authFor(viewer.token, "presence-org");
  check("a viewer cannot join presence (no chat capability)", viewerPresence.status === 403,
    `got ${viewerPresence.status}`);

  // ---- read watermark ----
  const marked = await api(bob.token, `/api/chat/conversations/${convId}/read`, {
    method: "POST",
    body: JSON.stringify({ lastReadMessageId: sendBody.message?.id ?? 0 }),
  });
  check("marking read succeeds", marked.status === 200);
} catch (err) {
  fail += 1;
  console.log(`
  THREW  ${(err as Error).stack ?? String(err)}`);
} finally {
  for (const hash of tokens) await sql`DELETE FROM auth_sessions WHERE token_hash = ${hash}`;
  for (const id of made) {
    await sql`DELETE FROM chat_conversations WHERE created_by = ${id}`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${id}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${id}`;
  }
  const left = (await sql`
    SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfyh_%'`) as { n: number }[];
  console.log(`\ncleanup: ${made.length} temp users removed, ${left[0]!.n} left behind`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
