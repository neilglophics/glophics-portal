/**
 * Integration check for reactions and group chat.  npm run verify:chat:social
 *
 * The unit suite (npm test) covers the pure logic — the toggle, the permission
 * matrix, the succession, the sentences. These are the properties only a real
 * database can prove:
 *
 *   - the primary key on (message, user, emoji) genuinely refuses a duplicate,
 *     so two taps cannot become two rows;
 *   - the toggle round-trips: add, remove, and back to nothing;
 *   - a soft-deleted message loses its reactions, and refuses new ones;
 *   - one owner per conversation is enforced by the partial unique index, not by
 *     hope;
 *   - a member cannot rename, a plain member cannot remove, an admin cannot
 *     remove another admin — the server refusing, not the UI hiding;
 *   - an owner leaving hands the group on, and the last one out deletes it;
 *   - system messages land in the thread, in order, with the right sentences;
 *   - existing DM behaviour is untouched — group operations refuse a DM outright.
 *
 * ⚠ IT WRITES TO WHATEVER DATABASE_URL POINTS AT. It creates users prefixed
 * "__vfy_" and removes everything it made in a finally block, but do not point it
 * at production — a crash between create and cleanup would leave rows behind.
 */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));

const {
  addGroupMembers,
  addableUsers,
  conversationDetail,
  createGroup,
  deleteMessage,
  leaveGroup,
  listMessages,
  openDirectMessage,
  reactionsFor,
  removeGroupMember,
  renameGroup,
  sendMessage,
  setGroupMemberRole,
  toggleReaction,
} = await import("../lib/db/queries/chat");

const made: string[] = [];
const conversations: string[] = [];
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

/** Runs something that should be refused, and reports the status it was refused
 *  with. A permission test that only checks "it threw" would pass on a typo. */
async function refuses(label: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, "it was allowed");
  } catch (err) {
    const got = (err as { status?: number }).status;
    check(label, got === status, `expected ${status}, got ${got}: ${(err as Error).message}`);
  }
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

/** Every message body in the thread, oldest first. */
async function bodies(conversationId: string, viewerId: string): Promise<string[]> {
  const page = await listMessages(conversationId, viewerId, { limit: 100 });
  return [...page.messages].reverse().map((m) => m.body);
}

try {
  const owner = await mkUser("own");
  const admin = await mkUser("adm");
  const member = await mkUser("mem");
  const outsider = await mkUser("out");

  // ================= reactions, in a DM =================
  console.log("\nreactions");

  const dm = await openDirectMessage(owner, member);
  conversations.push(dm.id);
  const sent = await sendMessage(dm.id, owner, { clientMsgId: "vfy-react-1", body: "deploying now" });
  const msgId = sent.message.id;

  const first = await toggleReaction(dm.id, msgId, member, "👍");
  check("first tap adds", first.added === true);
  check("the group carries the reactor", first.group.users.map((u) => u.id).join() === member);

  // The same emoji from the same person again REMOVES it. That is the toggle, and
  // it is also what makes a duplicate impossible: there is no code path that
  // inserts twice.
  const second = await toggleReaction(dm.id, msgId, member, "👍");
  check("second tap removes", second.added === false);
  check("the group is empty afterwards", second.group.users.length === 0);
  check("and the pill is gone", (await reactionsFor(msgId)).length === 0);

  // A different emoji from the same person coexists — Slack-style, which is what
  // the primary key on (message, user, emoji) expresses.
  await toggleReaction(dm.id, msgId, member, "👍");
  await toggleReaction(dm.id, msgId, member, "🎉");
  await toggleReaction(dm.id, msgId, owner, "👍");
  const groups = await reactionsFor(msgId);
  check("two emoji from one person coexist", groups.length === 2, JSON.stringify(groups));
  check(
    "👍 has both people",
    groups.find((g) => g.emoji === "👍")!.users.length === 2,
  );

  // The database, not the application, is what refuses a duplicate row.
  let duplicateRefused = false;
  try {
    await sql`
      INSERT INTO chat_message_reactions (message_id, user_id, emoji)
      VALUES (${msgId}, ${member}, '👍')
    `;
  } catch (err) {
    duplicateRefused = (err as { code?: string }).code === "23505";
  }
  check("the primary key refuses a duplicate row", duplicateRefused);

  await refuses("an emoji outside the allowlist is refused", 400, () =>
    toggleReaction(dm.id, msgId, member, "🤔"),
  );
  await refuses("a non-member cannot react", 404, () =>
    toggleReaction(dm.id, msgId, outsider, "👍"),
  );

  // A message in ANOTHER conversation cannot be reacted to by knowing its id:
  // the write is scoped to the conversation, not only to the membership check.
  const otherDm = await openDirectMessage(admin, outsider);
  conversations.push(otherDm.id);
  await refuses("a message from another conversation is not reachable", 404, () =>
    toggleReaction(otherDm.id, msgId, admin, "👍"),
  );

  // ---- reactions and deletion ----
  const doomed = await sendMessage(dm.id, owner, { clientMsgId: "vfy-del-1", body: "oops" });
  await toggleReaction(dm.id, doomed.message.id, member, "😂");
  check("the doomed message has a reaction", (await reactionsFor(doomed.message.id)).length === 1);

  await refuses("only the sender may delete", 403, () =>
    deleteMessage(dm.id, doomed.message.id, member),
  );

  await deleteMessage(dm.id, doomed.message.id, owner);
  check("deleting clears its reactions", (await reactionsFor(doomed.message.id)).length === 0);

  const afterDelete = await listMessages(dm.id, owner, { limit: 100 });
  const deletedRow = afterDelete.messages.find((m) => m.id === doomed.message.id)!;
  check("the row survives, so pagination has no hole", !!deletedRow);
  check("its body is not served", deletedRow.body === "");
  check("and it reports no reactions", deletedRow.reactions.length === 0);

  await refuses("a deleted message cannot be reacted to", 409, () =>
    toggleReaction(dm.id, doomed.message.id, member, "👍"),
  );

  const again = await deleteMessage(dm.id, doomed.message.id, owner);
  check("deleting twice is idempotent", again.alreadyDeleted === true);

  // ================= groups =================
  console.log("\ngroups");

  const group = await createGroup(owner, "  QA   coordination  ", [admin, member]);
  conversations.push(group.id);

  const detail = await conversationDetail(group.id, owner);
  check("the name is normalised", detail.title === "QA coordination", detail.title);
  check("the creator is the owner", detail.viewerRole === "owner");
  check("everybody is in it", detail.members.length === 3);
  check(
    "creation is recorded in the thread",
    (await bodies(group.id, owner))[0] === "Verify own created the group",
    JSON.stringify(await bodies(group.id, owner)),
  );

  // One owner, enforced by the partial unique index rather than by convention.
  let secondOwnerRefused = false;
  try {
    await sql`
      UPDATE chat_members SET member_role = 'owner'
       WHERE conversation_id = ${group.id} AND user_id = ${admin}
    `;
  } catch (err) {
    secondOwnerRefused = (err as { code?: string }).code === "23505";
  }
  check("a second owner is refused by the index", secondOwnerRefused);

  // ---- permissions ----
  await refuses("a plain member cannot rename", 403, () =>
    renameGroup(group.id, member, "Members only"),
  );
  await refuses("a non-member cannot rename", 404, () =>
    renameGroup(group.id, outsider, "Nope"),
  );
  await refuses("a rename to the same name is refused", 409, () =>
    renameGroup(group.id, owner, "QA coordination"),
  );
  await refuses("an empty name is refused", 400, () => renameGroup(group.id, owner, "   "));

  const renamed = await renameGroup(group.id, owner, "QA and release");
  check("the owner can rename", renamed.title === "QA and release");
  check(
    "the rename is recorded",
    renamed.systemMessage.body === 'Verify own changed the group name to "QA and release"',
    renamed.systemMessage.body,
  );

  // ---- the admin tier ----
  await refuses("an admin cannot hand out admin", 403, () =>
    setGroupMemberRole(group.id, admin, member, "admin"),
  );
  await setGroupMemberRole(group.id, owner, admin, "admin");
  check(
    "the owner can promote",
    (await conversationDetail(group.id, owner)).members.find((m) => m.id === admin)!.memberRole ===
      "admin",
  );

  const promoted = await renameGroup(group.id, admin, "Release train");
  check("an admin can rename", promoted.title === "Release train");

  // ---- membership ----
  await refuses("a plain member cannot add", 403, () =>
    addGroupMembers(group.id, member, [outsider]),
  );

  const addable = await addableUsers(group.id, owner);
  check(
    "the addable list excludes people already in",
    !addable.some((p) => p.id === owner || p.id === admin),
  );
  check("and includes the outsider", addable.some((p) => p.id === outsider));

  const added = await addGroupMembers(group.id, admin, [outsider]);
  check("an admin can add", added.added.includes(outsider));
  check(
    "each arrival is its own line",
    added.systemMessages.length === 1 &&
      added.systemMessages[0]!.body === "Verify adm added Verify out",
    JSON.stringify(added.systemMessages.map((m) => m.body)),
  );
  await refuses("adding somebody already in is refused", 409, () =>
    addGroupMembers(group.id, admin, [outsider]),
  );

  await refuses("nobody can remove the owner", 403, () =>
    removeGroupMember(group.id, admin, owner),
  );
  await refuses("removing yourself is not removal", 400, () =>
    removeGroupMember(group.id, admin, admin),
  );
  await refuses("a plain member cannot remove", 403, () =>
    removeGroupMember(group.id, member, outsider),
  );

  const removed = await removeGroupMember(group.id, admin, outsider);
  check("an admin can remove a member", removed.departedUserId === outsider);
  check(
    "the removal is recorded",
    removed.systemMessage.body === "Verify adm removed Verify out",
    removed.systemMessage.body,
  );
  await refuses("and they can no longer read it", 404, () =>
    listMessages(group.id, outsider, {}),
  );

  // An admin removing another admin: promote the member, then try.
  await setGroupMemberRole(group.id, owner, member, "admin");
  await refuses("an admin cannot remove another admin", 403, () =>
    removeGroupMember(group.id, admin, member),
  );

  // ---- leaving, and succession ----
  const left = await leaveGroup(group.id, member);
  check("a member can leave", left.deleted === false);
  check("leaving reads as leaving", left.systemMessage!.body === "Verify mem left the group");
  check("and hands nothing on", left.newOwnerId === null);

  const handover = await leaveGroup(group.id, owner);
  check("the owner leaving hands the group on", handover.newOwnerId === admin, String(handover.newOwnerId));
  const inherited = await conversationDetail(group.id, admin);
  check("the successor is the owner now", inherited.viewerRole === "owner");
  check("exactly one member is left", inherited.members.length === 1);

  const last = await leaveGroup(group.id, admin);
  check("the last one out deletes the group", last.deleted === true);
  const gone = (await sql`
    SELECT count(*)::int n FROM chat_conversations WHERE id = ${group.id}
  `) as { n: number }[];
  check("and the row is really gone", gone[0]!.n === 0);
  const orphanReactions = (await sql`
    SELECT count(*)::int n FROM chat_message_reactions r
      LEFT JOIN chat_messages m ON m.id = r.message_id
     WHERE m.id IS NULL
  `) as { n: number }[];
  check("cascade left no orphan reactions", orphanReactions[0]!.n === 0);

  // ================= DMs are untouched =================
  console.log("\ndirect messages are unaffected");

  await refuses("a DM cannot be renamed", 400, () => renameGroup(dm.id, owner, "Not a group"));
  await refuses("a DM cannot gain members", 400, () =>
    addGroupMembers(dm.id, owner, [outsider]),
  );
  await refuses("a DM cannot be left", 400, () => leaveGroup(dm.id, owner));

  const dmDetail = await conversationDetail(dm.id, owner);
  check("a DM still titles itself after the other person", dmDetail.title === "Verify mem", dmDetail.title);
  check("a DM has no photo of its own", dmDetail.avatarUrl === null);
  check("and both sides are plain members", dmDetail.members.every((m) => m.memberRole === "member"));
} catch (err) {
  // Counted as a failure, not swallowed. Without this the `finally` below exits
  // 0 on an unexpected throw and the run reads as a clean pass that simply
  // stopped early — which is exactly how a broken succession looked once.
  fail += 1;
  console.log(`\n  FAIL  unexpected error: ${(err as Error).message}`);
  console.log((err as Error).stack ?? "");
} finally {
  // Conversations first: auth_users cascades to chat_members but only nulls
  // chat_messages.sender_id, so a conversation created by a temp user would
  // otherwise survive them.
  for (const id of conversations) {
    await sql`DELETE FROM chat_conversations WHERE id = ${id}`;
  }
  for (const id of made) {
    await sql`DELETE FROM chat_conversations WHERE created_by = ${id}`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${id}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${id}`;
  }
  const left = (await sql`
    SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfy_%'
  `) as { n: number }[];
  console.log(`\ncleanup: ${made.length} temp users removed, ${left[0]!.n} left behind`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
