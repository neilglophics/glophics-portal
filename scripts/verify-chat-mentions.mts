/**
 * Integration check for @mentions.  npm run verify:chat:mentions
 *
 * The unit suite covers the token format and the composer's query detection.
 * These are the properties only a real database can prove, and the first is the
 * one that matters:
 *
 *   - a NON-MEMBER cannot be mentioned, however the request is crafted;
 *   - a member can, and a row lands in chat_message_mentions;
 *   - the sender mentioning themselves does not notify them;
 *   - the mention survives a rename — the id is what is stored;
 *   - the length limit is measured on the plain form, not the raw token;
 *   - deleting a message takes its mention rows with it.
 *
 * ⚠ Writes to whatever DATABASE_URL points at. Cleans up after itself.
 */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));

const { createGroup, deleteMessage, listMessages, openDirectMessage, sendMessage } = await import(
  "../lib/db/queries/chat"
);
const { mentionToken, plainText } = await import("../lib/chat/mentions");
const { MESSAGE_MAX_LENGTH } = await import("../lib/chat/limits");

const users: string[] = [];
const conversations: string[] = [];
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
  users.push(rows[0]!.id);
  return rows[0]!.id;
}

async function mentionRows(messageId: number): Promise<string[]> {
  const rows = (await sql`
    SELECT user_id FROM chat_message_mentions WHERE message_id = ${messageId} ORDER BY user_id
  `) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

try {
  const alice = await mkUser("a");
  const bob = await mkUser("b");
  const outsider = await mkUser("o");

  const group = await createGroup(alice, "Mentions group", [bob]);
  conversations.push(group.id);

  console.log("\nmentioning a member");

  const sent = await sendMessage(group.id, alice, {
    clientMsgId: "vfy-mention-1",
    body: `morning ${mentionToken(bob, "Verify b")} can you look?`,
  });
  check("the send reports the mention", sent.mentionIds.includes(bob), JSON.stringify(sent.mentionIds));
  check("and a row is written", (await mentionRows(sent.message.id)).includes(bob));

  console.log("\nnon-members cannot be mentioned");

  const hostile = await sendMessage(group.id, alice, {
    clientMsgId: "vfy-mention-outsider",
    body: `hey ${mentionToken(outsider, "Verify o")}`,
  });
  // The id came straight from a request body. Without the membership filter this
  // would notify somebody who is not in the group.
  check("a non-member is not reported", !hostile.mentionIds.includes(outsider), JSON.stringify(hostile.mentionIds));
  check("and no row is written for them", !(await mentionRows(hostile.message.id)).includes(outsider));
  check("the message itself still sends", hostile.created === true);

  console.log("\nself-mentions do not notify");

  const self = await sendMessage(group.id, alice, {
    clientMsgId: "vfy-mention-self",
    body: `note to self ${mentionToken(alice, "Verify a")}`,
  });
  check("the sender is excluded", !self.mentionIds.includes(alice), JSON.stringify(self.mentionIds));
  check("and gets no row", !(await mentionRows(self.message.id)).includes(alice));

  console.log("\nmentions survive a rename");

  await sql`UPDATE auth_users SET display_name = 'Renamed Person' WHERE id = ${bob}`;
  const page = await listMessages(group.id, alice, { limit: 50 });
  const stored = page.messages.find((m) => m.id === sent.message.id)!;
  // The BODY keeps the old name as a fallback; what matters is that the id is
  // still in it, so the renderer can resolve today's name from the member list.
  check("the id is still in the body", stored.body.includes(bob));
  check(
    "and the mention row still points at them",
    (await mentionRows(sent.message.id)).includes(bob),
  );

  console.log("\nlength is measured on the plain form");

  // A body that is comfortably under the limit as a person sees it, but well over
  // it once the uuids are counted.
  const many = Array.from({ length: 45 }, () => mentionToken(bob, "Verify b")).join(" ");
  check("the raw body is over the limit", many.length > MESSAGE_MAX_LENGTH, String(many.length));
  check("but the plain form is under it", plainText(many).length < MESSAGE_MAX_LENGTH, String(plainText(many).length));

  const long = await sendMessage(group.id, alice, { clientMsgId: "vfy-mention-long", body: many });
  check("so it sends", long.created === true);

  console.log("\ndeleting takes the mentions with it");

  await deleteMessage(group.id, sent.message.id, alice);
  check("the rows are gone", (await mentionRows(sent.message.id)).length === 0);

  console.log("\nDMs are unaffected");

  const dm = await openDirectMessage(alice, bob);
  conversations.push(dm.id);
  const dmMsg = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-mention-dm",
    body: `hi ${mentionToken(bob, "Verify b")}`,
  });
  // A DM has one other member, so mentioning them is valid — the UI simply does
  // not offer a picker for it.
  check("a DM mention of the other person works", dmMsg.mentionIds.includes(bob));
  const dmOutsider = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-mention-dm-outsider",
    body: `hi ${mentionToken(outsider, "Verify o")}`,
  });
  check("but a non-member is still filtered", !dmOutsider.mentionIds.includes(outsider));
} catch (err) {
  fail += 1;
  console.log(`\n  FAIL  unexpected error: ${(err as Error).message}`);
  console.log((err as Error).stack ?? "");
} finally {
  for (const id of conversations) await sql`DELETE FROM chat_conversations WHERE id = ${id}`;
  for (const id of users) {
    await sql`DELETE FROM chat_conversations WHERE created_by = ${id}`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${id}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${id}`;
  }
  console.log(`\ncleanup: ${users.length} temp users removed`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
