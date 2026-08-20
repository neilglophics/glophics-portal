/**
 * End-to-end check of the avatar pipeline.  npm run verify:avatar
 *
 * Proves the parts that only a running server and a real image can prove: that
 * the 1 MB limit is enforced server-side, that a non-image is refused, that the
 * optimiser is actually reached, and that what gets stored is the optimised WebP
 * rather than whatever was uploaded.
 *
 * ⚠ Needs a dev server and writes to DATABASE_URL. Creates a temporary login and
 * removes it in a finally block. Do not aim it at production.
 */

import crypto from "node:crypto";
import zlib from "node:zlib";
import { neon } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();
const sql = neon(requireEnv("DATABASE_URL"));
const BASE = process.env.VERIFY_BASE ?? "http://localhost:3000";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
};

/** A real, valid RGB PNG, built by hand so the script needs no image library. */
function makePng(width: number, height: number): Buffer {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      // Noise, so it does not compress to nothing and the size test is honest.
      raw[o++] = (x * 7 + y * 13) % 256;
      raw[o++] = (x * 31 + y * 3) % 256;
      raw[o++] = (x * 17 + y * 29) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let userId: string | null = null;
let tokenHash: string | null = null;

try {
  if (!(await fetch(`${BASE}/login`, { redirect: "manual" }).catch(() => null))) {
    console.error(`\nNo server at ${BASE}. Start it with \`npm run dev\`.\n`);
    process.exit(1);
  }

  const salt = crypto.randomBytes(8).toString("hex");
  const rows = (await sql`
    INSERT INTO auth_users (username, display_name, role, salt, hash)
    VALUES (${`__vfya_${salt.slice(0, 6)}`}, 'Verify Avatar', 'member', ${salt}, 'x')
    RETURNING id
  `) as { id: string }[];
  userId = rows[0]!.id;

  const token = crypto.randomBytes(32).toString("hex");
  tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await sql`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, now() + interval '1 hour')
  `;

  const upload = async (bytes: Buffer, type: string, name = "pic.png") => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type }), name);
    const res = await fetch(`${BASE}/api/me/avatar`, {
      method: "POST",
      headers: { Cookie: `sm_session=${token}` },
      body: form,
      redirect: "manual",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  };

  // ---- the 1 MB limit ----
  const big = makePng(700, 700); // uncompressed IDAT, comfortably over 1 MB
  check("test image really is over 1 MB", big.length > 1024 * 1024, `${big.length}B`);

  const rejected = await upload(big, "image/png");
  check("an over-1MB image is REFUSED with 413", rejected.status === 413, `got ${rejected.status}`);
  check("and says how big it was", String(rejected.body.error ?? "").includes("MB"),
    String(rejected.body.error));

  // ---- type allowlist ----
  const notAnImage = Buffer.from("#!/bin/sh\necho definitely not a picture\n");
  const wrongType = await upload(notAnImage, "text/plain", "script.sh");
  check("a non-image MIME is refused with 415", wrongType.status === 415, `got ${wrongType.status}`);

  // A file CLAIMING to be a PNG but which is not — the allowlist passes it, so
  // the optimiser is what has to catch it.
  const liar = await upload(notAnImage, "image/png", "liar.png");
  check("a file lying about being a PNG is refused by the optimiser",
    liar.status === 502, `got ${liar.status}: ${String(liar.body.error ?? "")}`);

  // ---- the happy path ----
  const good = makePng(600, 400);
  check("a valid image is under the limit", good.length < 1024 * 1024, `${good.length}B`);

  const ok = await upload(good, "image/png");
  check("a valid image is accepted", ok.status === 200, `got ${ok.status}: ${JSON.stringify(ok.body)}`);
  check("it was actually optimised (smaller than the original)",
    Number(ok.body.processedSize) > 0 && Number(ok.body.processedSize) < good.length,
    `${good.length} -> ${ok.body.processedSize}`);
  check("it was resized inside 256x256",
    Number(ok.body.width) <= 256 && Number(ok.body.height) <= 256,
    `${ok.body.width}x${ok.body.height}`);

  // ---- what got stored ----
  const stored = (await sql`
    SELECT mime, width, height, byte_size FROM auth_user_avatars WHERE user_id = ${userId}
  `) as { mime: string; width: number; height: number; byte_size: number }[];
  check("stored as WebP, not the uploaded PNG", stored[0]?.mime === "image/webp", stored[0]?.mime);
  check("stored bytes match the reported size", stored[0]?.byte_size === Number(ok.body.processedSize));

  // ---- serving ----
  const url = String(ok.body.url);
  const served = await fetch(`${BASE}${url}`, {
    headers: { Cookie: `sm_session=${token}` },
    redirect: "manual",
  });
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check("the image serves to a signed-in viewer", served.status === 200, `got ${served.status}`);
  check("with an image content type", (served.headers.get("content-type") ?? "").startsWith("image/"));
  check("and is really WebP (RIFF....WEBP)",
    servedBytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      servedBytes.subarray(8, 12).toString("latin1") === "WEBP");

  const etag = served.headers.get("etag");
  const revalidated = await fetch(`${BASE}${url}`, {
    headers: { Cookie: `sm_session=${token}`, "If-None-Match": etag ?? "" },
    redirect: "manual",
  });
  check("a matching ETag gets 304, not the bytes again", revalidated.status === 304,
    `got ${revalidated.status}`);

  const anonymous = await fetch(`${BASE}${url}`, { redirect: "manual" });
  check("it is NOT public — no session, no image", anonymous.status !== 200, `got ${anonymous.status}`);

  // ---- removal ----
  const removed = await fetch(`${BASE}/api/me/avatar`, {
    method: "DELETE",
    headers: { Cookie: `sm_session=${token}` },
    redirect: "manual",
  });
  check("removal succeeds", removed.status === 200);
  const after = (await sql`
    SELECT count(*)::int n FROM auth_user_avatars WHERE user_id = ${userId}
  `) as { n: number }[];
  check("and the row is gone", after[0]!.n === 0);
} catch (err) {
  fail += 1;
  console.log(`\n  THREW  ${(err as Error).stack ?? String(err)}`);
} finally {
  if (tokenHash) await sql`DELETE FROM auth_sessions WHERE token_hash = ${tokenHash}`;
  if (userId) {
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`%${userId}`}`;
    await sql`DELETE FROM auth_users WHERE id = ${userId}`;
  }
  const left = (await sql`
    SELECT count(*)::int n FROM auth_users WHERE username LIKE '__vfya_%'`) as { n: number }[];
  console.log(`\ncleanup: temp login removed, ${left[0]!.n} left behind`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
