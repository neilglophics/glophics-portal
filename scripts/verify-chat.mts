/**
 * Integration check for the chat query layer.  npm run verify:chat
 *
 * The unit suite (npm test) covers pure logic. These are the properties that
 * only a real database can prove: that the unique index actually makes a retry
 * idempotent, that keyset pagination has no gaps or repeats, that a non-member
 * is refused, and that the rate limiter refuses at the right count.
 *
 * ⚠ IT WRITES TO WHATEVER DATABASE_URL POINTS AT. It creates users prefixed
 * "__vfy_" and removes everything it made in a finally block, but do not point
 * it at production — a crash between create and cleanup would leave rows behind.
 */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));

const {
  assertMember,
  conversationUnread,
  notificationTargets,
  dmKey,
  listConversations,
  listMessages,
  markRead,
  openDirectMessage,
  sendMessage,
  totalUnread,
} = await import("../lib/db/queries/chat");
const { consume } = await import("../lib/rate-limit");

const made: string[] = [];
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
}

async function mkUser(tag: string): Promise<string> {
  const salt = crypto.randomBytes(8).toString("hex");
  const rows = (await sql`
    INSERT INTO auth_users (username, display_name, role, salt, hash)
    VALUES (${`__vfy_${tag}_${salt.slice(0, 6)}`}, ${`Verify ${tag}`}, 'member', ${salt}, 'x')
    RETURNING id
  `) as { id: string }[];
  made.push(rows[0]!.id);
  return rows[0]!.id;
}

try {
  const alice = await mkUser("a");
  const bob = await mkUser("b");
  const carol = await mkUser("c");

  // ---- dm identity is symmetric ----
  check("dmKey is symmetric", dmKey(alice, bob) === dmKey(bob, alice));

  // ---- opening a DM is idempotent ----
  const first = await openDirectMessage(alice, bob);
  const second = await openDirectMessage(bob, alice);
  check("second open returns the same conversation", first.id === second.id, `${first.id} vs ${second.id}`);
  check("second open reports created=false", second.created === false);

  // ---- idempotent send ----
  const cid = "client-msg-fixed-1";
  const a = await sendMessage(first.id, alice, { clientMsgId: cid, body: "hello" });
  const b = await sendMessage(first.id, alice, { clientMsgId: cid, body: "hello" });
  check("retry returns created=false", a.created === true && b.created === false);
  check("retry returns the SAME message id", a.message.id === b.message.id);

  const dupes = (await sql`
    SELECT count(*)::int n FROM chat_messages
     WHERE conversation_id = ${first.id} AND client_msg_id = ${cid}
  `) as { n: number }[];
  check("only one row stored for a duplicate clientMsgId", dupes[0]!.n === 1, `n=${dupes[0]!.n}`);

  // ---- notify excludes the sender ----
  check("notify excludes the sender", a.notify.length === 1 && a.notify[0] === bob);

  // ---- keyset pagination: no gaps, no repeats ----
  for (let i = 0; i < 7; i += 1) {
    await sendMessage(first.id, alice, { clientMsgId: `p-${i}`, body: `msg ${i}` });
  }
  const page1 = await listMessages(first.id, alice, { limit: 3 });
  const page2 = await listMessages(first.id, alice, { limit: 3, before: page1.messages.at(-1)!.id });
  const ids1 = page1.messages.map((m) => m.id);
  const ids2 = page2.messages.map((m) => m.id);

  check("page 1 is newest-first", ids1.every((id, i) => i === 0 || id < ids1[i - 1]!));
  check("page 2 does not repeat page 1", ids2.every((id) => !ids1.includes(id)));
  check("page 2 is strictly older than page 1", Math.max(...ids2) < Math.min(...ids1));
  check("hasMore is reported", page1.hasMore === true);

  // ---- catch-up direction ----
  const newer = await listMessages(first.id, alice, { after: ids1.at(-1)! });
  check("after= returns only newer messages", newer.messages.every((m) => m.id > ids1.at(-1)!));

  // ---- membership is the boundary ----
  let refused = false;
  try {
    await listMessages(first.id, carol, {});
  } catch { refused = true; }
  check("a NON-MEMBER cannot read messages", refused);

  refused = false;
  try {
    await sendMessage(first.id, carol, { clientMsgId: "x", body: "intruding" });
  } catch { refused = true; }
  check("a NON-MEMBER cannot send", refused);

  refused = false;
  try { await assertMember(first.id, carol); } catch { refused = true; }
  check("assertMember refuses a non-member", refused);

  // ---- unread and watermark ----
  const bobUnread = await totalUnread(bob);
  check("recipient has unread messages", bobUnread > 0, `n=${bobUnread}`);
  check("sender has none of their own", (await totalUnread(alice)) === 0);

  const newest = (await listMessages(first.id, bob, { limit: 1 })).messages[0]!.id;
  await markRead(first.id, bob, newest);
  check("marking read clears unread", (await totalUnread(bob)) === 0);

  await markRead(first.id, bob, 1);
  check("watermark only moves FORWARD", (await totalUnread(bob)) === 0);

  // ---- conversation list shape ----
  const list = await listConversations(bob);
  check("conversation appears in the member's list", list.some((c) => c.id === first.id));
  check("a DM is titled with the other person", list.find((c) => c.id === first.id)?.title === "Verify a");
  check("carol sees no conversations", (await listConversations(carol)).length === 0);

  // ---- notification targeting ----
  // Bob's watermark was advanced above, so send something new before asserting
  // that unread is counted — otherwise zero is the correct answer and the check
  // proves nothing.
  await sendMessage(first.id, alice, { clientMsgId: "notify-1", body: "ping" });
  const perThread = await conversationUnread(first.id, bob);
  const overall = await totalUnread(bob);
  check("per-conversation unread is counted separately from the total",
    perThread > 0 && overall >= perThread, `thread=${perThread} total=${overall}`);
  check("the sender counts none of it as unread", (await conversationUnread(first.id, alice)) === 0);

  const targets = await notificationTargets(first.id, alice);
  check("targets exclude the sender", !targets.recipients.includes(alice));
  check("targets include the other member", targets.recipients.includes(bob));
  check("a DM reports kind=dm", targets.kind === "dm");

  // Mute is honoured on the SERVER, so a muted thread costs no Pusher message
  // at all rather than being filtered in the client.
  await sql`
    UPDATE chat_members SET muted = true
     WHERE conversation_id = ${first.id} AND user_id = ${bob}
  `;
  const muted = await notificationTargets(first.id, alice);
  check("a MUTED member is not a notification target", !muted.recipients.includes(bob),
    JSON.stringify(muted.recipients));
  await sql`
    UPDATE chat_members SET muted = false
     WHERE conversation_id = ${first.id} AND user_id = ${bob}
  `;

  // ---- rate limiting actually refuses ----
  let allowed = 0;
  for (let i = 0; i < 25; i += 1) {
    if ((await consume("chat.send", alice)).ok) allowed += 1;
  }
  check("rate limit caps sends at 20 per window", allowed === 20, `allowed=${allowed}`);
} finally {
  // auth_users cascades to chat_members and sets chat_messages.sender_id null,
  // so conversations have to go explicitly.
  for (const id of made) {
    await sql`DELETE FROM chat_conversations WHERE created_by = ${id}`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${id}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${id}`;
  }
  const left = (await sql`SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfy_%'`) as { n: number }[];
  console.log(`\ncleanup: ${made.length} temp users removed, ${left[0]!.n} left behind`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
