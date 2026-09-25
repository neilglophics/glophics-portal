/**
 * Integration check for attachments and replies.  npm run verify:chat:files
 *
 * The unit suite covers the allowlist, the sanitiser and the formatters. These are
 * the properties only a real database and a real blob store can prove:
 *
 *   - a round trip: bytes to the store, metadata to Postgres, bytes back out;
 *   - the store is PRIVATE — an unauthenticated fetch of a blob URL is refused,
 *     which is the whole of docs/06-OPEN-QUESTIONS.md Q6;
 *   - `claimAttachments` refuses somebody else's staged file, a file staged for a
 *     different conversation, and a file already sent — all four WHERE conditions;
 *   - a partial claim fails the whole send rather than sending four of five files;
 *   - attachment-only and text+attachment messages both send;
 *   - a reply's quote survives a reload, and reflects the parent being deleted;
 *   - a reply cannot point at a message in another conversation;
 *   - the orphan sweep finds abandoned uploads and nothing else.
 *
 * ⚠ IT WRITES TO WHATEVER DATABASE_URL AND BLOB_READ_WRITE_TOKEN POINT AT. It
 * creates users prefixed "__vfy_" and blobs under chat/<conversation>/ and removes
 * everything it made in a finally block — but do not point it at production.
 */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));

const {
  createGroup,
  deleteMessage,
  listMessages,
  openDirectMessage,
  sendMessage,
} = await import("../lib/db/queries/chat");
const {
  attachmentForDownload,
  discardStagedAttachment,
  stageAttachment,
  stagedAttachments,
  sweepStaleStaged,
} = await import("../lib/db/queries/attachments");
const { deleteAttachment, isBlobConfigured, putAttachment, readAttachment } = await import(
  "../lib/blob/store"
);
const { isAnimatedGif, looksLikeGif } = await import("../lib/chat/attachments");

const users: string[] = [];
const conversations: string[] = [];
const blobs: string[] = [];
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
  users.push(rows[0]!.id);
  return rows[0]!.id;
}

/** Uploads bytes and stages a row, the way the route does. */
async function stage(
  conversationId: string,
  uploaderId: string,
  filename: string,
  mime: string,
  body: Buffer,
) {
  const stored = await putAttachment({ conversationId, filename, contentType: mime, body });
  if (!stored) throw new Error("blob store not configured");
  blobs.push(stored.url);

  return stageAttachment({
    conversationId,
    uploadedBy: uploaderId,
    blobUrl: stored.url,
    blobPathname: stored.pathname,
    filename,
    mime,
    bytes: body.length,
    width: null,
    height: null,
  });
}

try {
  check("the blob store is configured", isBlobConfigured());

  const alice = await mkUser("a");
  const bob = await mkUser("b");
  const outsider = await mkUser("o");

  const dm = await openDirectMessage(alice, bob);
  conversations.push(dm.id);
  const other = await openDirectMessage(alice, outsider);
  conversations.push(other.id);

  // ================= the round trip =================
  console.log("\nstorage round trip");

  const pdfBytes = Buffer.from("%PDF-1.4\nnot really a pdf\n");
  const staged = await stage(dm.id, alice, "spec.pdf", "application/pdf", pdfBytes);

  check("staging returns a row with no message", staged.messageId === null);
  check("and records the size", staged.bytes === pdfBytes.length, String(staged.bytes));
  check(
    "the view carries no blob location",
    !("blobUrl" in staged) && !("blobPathname" in staged),
    JSON.stringify(Object.keys(staged)),
  );

  const pending = await stagedAttachments(dm.id, alice);
  check("the uploader sees their own staged file", pending.some((a) => a.id === staged.id));
  const pendingForBob = await stagedAttachments(dm.id, bob);
  check("nobody else sees it", !pendingForBob.some((a) => a.id === staged.id));

  // ---- Q6: the store is private ----
  const rawUrl = (await sql`
    SELECT blob_url FROM chat_attachments WHERE id = ${staged.id}
  `) as { blob_url: string }[];
  const anonymous = await fetch(rawUrl[0]!.blob_url);
  check(
    "an unauthenticated fetch of the blob URL is refused",
    anonymous.status === 403,
    `got ${anonymous.status}`,
  );

  // ---- reading it back through the app's own path ----
  const forDownload = await attachmentForDownload(staged.id, alice);
  check("the uploader may read a staged file", !!forDownload);
  check("a non-uploader may NOT read a staged file", !(await attachmentForDownload(staged.id, bob)));
  check("a non-member may not read it", !(await attachmentForDownload(staged.id, outsider)));

  const opened = await readAttachment(forDownload!.blobPathname);
  check("the bytes come back", !!opened);
  const roundTripped = Buffer.from(await new Response(opened!.stream).arrayBuffer());
  check("byte-for-byte identical", roundTripped.equals(pdfBytes), `${roundTripped.length} bytes`);

  // ================= claiming =================
  console.log("\nclaiming on send");

  const bobsFile = await stage(dm.id, bob, "bob.txt", "text/plain", Buffer.from("bob"));
  const elsewhere = await stage(other.id, alice, "elsewhere.txt", "text/plain", Buffer.from("x"));

  await refuses("a file staged by somebody else cannot be attached", 400, () =>
    sendMessage(dm.id, alice, {
      clientMsgId: "vfy-claim-other-user",
      body: "not mine",
      attachmentIds: [bobsFile.id],
    }),
  );

  await refuses("a file staged for another conversation cannot be attached", 400, () =>
    sendMessage(dm.id, alice, {
      clientMsgId: "vfy-claim-other-conv",
      body: "wrong thread",
      attachmentIds: [elsewhere.id],
    }),
  );

  await refuses("a partial claim fails the whole send", 400, () =>
    sendMessage(dm.id, alice, {
      clientMsgId: "vfy-claim-partial",
      body: "four of five",
      attachmentIds: [staged.id, crypto.randomUUID()],
    }),
  );

  // The message must not exist after that rollback — this is the property the
  // transaction is for.
  const afterRollback = (await sql`
    SELECT count(*)::int n FROM chat_messages
     WHERE conversation_id = ${dm.id} AND client_msg_id = 'vfy-claim-partial'
  `) as { n: number }[];
  check("and leaves no message behind", afterRollback[0]!.n === 0);
  check(
    "and leaves the good file still staged",
    (await stagedAttachments(dm.id, alice)).some((a) => a.id === staged.id),
  );

  // ---- a real send, text + attachment ----
  const withFile = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-with-file",
    body: "here is the spec",
    attachmentIds: [staged.id],
  });
  check("text + attachment sends", withFile.message.attachments.length === 1);
  check("and the message keeps kind=text", withFile.message.kind === "text");
  check("bob can now read the file", !!(await attachmentForDownload(staged.id, bob)));

  await refuses("the same file cannot be attached twice", 400, () =>
    sendMessage(dm.id, alice, {
      clientMsgId: "vfy-reattach",
      body: "again",
      attachmentIds: [staged.id],
    }),
  );

  // ---- attachment-only ----
  const imageOnly = await stage(dm.id, alice, "shot.webp", "image/webp", Buffer.from("fake-webp"));
  const noText = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-file-only",
    body: "",
    attachmentIds: [imageOnly.id],
  });
  check("attachment-only sends", noText.message.attachments.length === 1);
  check("and is marked kind=attachment", noText.message.kind === "attachment", noText.message.kind);

  await refuses("nothing at all is still refused", 400, () =>
    sendMessage(dm.id, alice, { clientMsgId: "vfy-empty", body: "", attachmentIds: [] }),
  );

  // ---- the retry path ----
  const retry = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-with-file",
    body: "here is the spec",
    attachmentIds: [staged.id],
  });
  check("a retried send is idempotent", retry.created === false);
  check(
    "and reports the attachments the first attempt claimed",
    retry.message.attachments.length === 1,
    String(retry.message.attachments.length),
  );

  // ================= replies =================
  console.log("\nreplies");

  const parent = await sendMessage(dm.id, bob, {
    clientMsgId: "vfy-parent",
    body: "is staging free?",
  });

  const reply = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-reply",
    body: "yes, until 4",
    replyToId: parent.message.id,
  });
  check("a reply records its parent", reply.message.replyToId === parent.message.id);
  check("and carries the quote", reply.message.replyTo?.preview === "is staging free?");
  check("with the parent's sender", reply.message.replyTo?.senderName === "Verify b");

  // The relationship has to survive a reload — that is what "preserve it in the
  // database" means.
  const page = await listMessages(dm.id, alice, { limit: 100 });
  const reloaded = page.messages.find((m) => m.id === reply.message.id)!;
  check("the quote survives a reload", reloaded.replyTo?.preview === "is staging free?");
  check("and still names the parent", reloaded.replyTo?.id === parent.message.id);

  await refuses("a reply cannot point outside its conversation", 404, () =>
    sendMessage(other.id, alice, {
      clientMsgId: "vfy-cross-reply",
      body: "wrong thread",
      replyToId: parent.message.id,
    }),
  );

  await refuses("a reply cannot point at a message that does not exist", 404, () =>
    sendMessage(dm.id, alice, {
      clientMsgId: "vfy-ghost-reply",
      body: "nowhere",
      replyToId: 999_999_999,
    }),
  );

  // ---- replying to an attachment-only message ----
  const replyToFile = await sendMessage(dm.id, bob, {
    clientMsgId: "vfy-reply-to-file",
    body: "nice",
    replyToId: noText.message.id,
  });
  check(
    "an attachment-only parent is still quotable",
    replyToFile.message.replyTo?.preview === "Photo",
    JSON.stringify(replyToFile.message.replyTo?.preview),
  );
  check(
    "and the quote offers a thumbnail",
    replyToFile.message.replyTo?.thumbnailAttachmentId === imageOnly.id,
  );

  // ---- the parent being deleted ----
  await deleteMessage(dm.id, parent.message.id, bob);
  const afterDelete = await listMessages(dm.id, alice, { limit: 100 });
  const orphanedReply = afterDelete.messages.find((m) => m.id === reply.message.id)!;
  check("the reply survives its parent's deletion", !!orphanedReply.replyTo);
  check("and says so instead of quoting it", orphanedReply.replyTo?.preview === "Message deleted");
  check("and is flagged deleted", orphanedReply.replyTo?.deleted === true);

  // A deleted message's files stop being served immediately.
  const deletedFileMsg = await sendMessage(dm.id, alice, {
    clientMsgId: "vfy-doomed-file",
    body: "",
    attachmentIds: [(await stage(dm.id, alice, "doomed.txt", "text/plain", Buffer.from("d"))).id],
  });
  const doomedId = deletedFileMsg.message.attachments[0]!.id;
  check("its file is readable while the message lives", !!(await attachmentForDownload(doomedId, bob)));
  await deleteMessage(dm.id, deletedFileMsg.message.id, alice);
  check(
    "and unreadable the moment it is deleted",
    !(await attachmentForDownload(doomedId, bob)),
  );
  const afterMsgDelete = await listMessages(dm.id, alice, { limit: 100 });
  check(
    "a deleted message serves no attachment metadata",
    afterMsgDelete.messages.find((m) => m.id === deletedFileMsg.message.id)!.attachments.length === 0,
  );

  console.log("\nanimated GIFs survive intact");

  // A hand-built two-frame 1x1 animated GIF: the smallest thing that genuinely
  // animates. The optimiser turns this into a single-frame WebP, which is why the
  // upload route skips it for GIFs — this asserts the bytes come back untouched.
  const animated = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0xff, 0x00, 0x00, 0x00, 0x00, 0xff,
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);

  check("the fixture really is an animated gif", looksLikeGif(animated) && isAnimatedGif(animated));

  const gif = await stage(dm.id, alice, "party.gif", "image/gif", animated);
  check("a gif keeps its own mime type", gif.mime === "image/gif", gif.mime);
  check("and its own filename", gif.filename.endsWith(".gif"), gif.filename);

  const gifMeta = await attachmentForDownload(gif.id, alice);
  const gifBytes = Buffer.from(
    await new Response((await readAttachment(gifMeta!.blobPathname))!.stream).arrayBuffer(),
  );
  check("the stored bytes are byte-for-byte the original", gifBytes.equals(animated));
  check("so it is STILL animated after the round trip", isAnimatedGif(gifBytes));
  check("and is served as image/gif", gifMeta!.mime === "image/gif", gifMeta!.mime);

  // ================= discarding and sweeping =================
  console.log("\nhousekeeping");

  const discardable = await stage(dm.id, alice, "oops.txt", "text/plain", Buffer.from("oops"));
  check("a non-uploader cannot discard it", !(await discardStagedAttachment(discardable.id, bob)));
  check("the uploader can", !!(await discardStagedAttachment(discardable.id, alice)));
  check(
    "discarding twice is a no-op",
    !(await discardStagedAttachment(discardable.id, alice)),
  );
  check("a SENT attachment cannot be discarded", !(await discardStagedAttachment(staged.id, alice)));

  // The sweep only takes staged rows, and only old ones.
  const fresh = await stage(dm.id, alice, "fresh.txt", "text/plain", Buffer.from("f"));
  const sweptNothing = await sweepStaleStaged(24);
  check("the sweep leaves a fresh staged file alone", !sweptNothing.length, String(sweptNothing.length));

  await sql`
    UPDATE chat_attachments SET created_at = now() - interval '2 days' WHERE id = ${fresh.id}
  `;
  const swept = await sweepStaleStaged(24);
  check("and collects an abandoned one", swept.length === 1, String(swept.length));
  const stillThere = (await sql`
    SELECT count(*)::int n FROM chat_attachments WHERE id = ${fresh.id}
  `) as { n: number }[];
  check("removing its row too", stillThere[0]!.n === 0);
  const sentSurvives = (await sql`
    SELECT count(*)::int n FROM chat_attachments WHERE id = ${staged.id}
  `) as { n: number }[];
  check("and never touching a sent one", sentSurvives[0]!.n === 1);

  // ================= groups =================
  console.log("\ngroups carry files too");

  const group = await createGroup(alice, "Files group", [bob]);
  conversations.push(group.id);
  const groupFile = await stage(group.id, alice, "notes.txt", "text/plain", Buffer.from("n"));
  const groupMsg = await sendMessage(group.id, alice, {
    clientMsgId: "vfy-group-file",
    body: "notes attached",
    attachmentIds: [groupFile.id],
  });
  check("a group message carries attachments", groupMsg.message.attachments.length === 1);
  check("a group member can read them", !!(await attachmentForDownload(groupFile.id, bob)));
  check("an outsider cannot", !(await attachmentForDownload(groupFile.id, outsider)));
} catch (err) {
  fail += 1;
  console.log(`\n  FAIL  unexpected error: ${(err as Error).message}`);
  console.log((err as Error).stack ?? "");
} finally {
  // Blobs first — once the rows are gone their locations are unknowable.
  let removed = 0;
  for (const url of blobs) {
    if (await deleteAttachment(url)) removed += 1;
  }
  for (const id of conversations) {
    await sql`DELETE FROM chat_conversations WHERE id = ${id}`;
  }
  for (const id of users) {
    await sql`DELETE FROM chat_conversations WHERE created_by = ${id}`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${id}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${id}`;
  }

  const left = (await sql`
    SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfy_%'
  `) as { n: number }[];
  console.log(
    `\ncleanup: ${users.length} temp users removed, ${removed}/${blobs.length} blobs deleted, ${left[0]!.n} users left behind`,
  );
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
