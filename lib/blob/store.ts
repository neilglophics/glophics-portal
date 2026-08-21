/**
 * Vercel Blob, wrapped.
 *
 * **Server-only.** This module reads `BLOB_READ_WRITE_TOKEN` and must never be
 * imported from a client component — the same rule as lib/realtime/server.ts.
 *
 * ── The store is PRIVATE, and that is the whole security model ──
 *
 * docs/06-OPEN-QUESTIONS.md Q6 asked whether a Blob URL is a capability that
 * whoever holds it can read forever, regardless of conversation membership. For
 * this store the question does not arise, and it was settled by probing the live
 * store rather than by reading docs:
 *
 *   - `put({ access: "public" })` is **refused**: "Cannot use public access on a
 *     private store."
 *   - a blob URL fetched with no credentials answers **403 Forbidden**.
 *
 * So there is no capability URL to leak, and reads are only possible server-side
 * with the token. Every download therefore goes through
 * `/api/chat/attachments/[id]`, which checks conversation membership and streams
 * the bytes — Q6's recommended option B, arrived at by necessity rather than by
 * discipline, which is the better kind.
 *
 * `blob_url` is stored because the SDK's delete takes it unambiguously, and it is
 * **never serialised to a client**. It would be useless there, but "useless" is a
 * property of today's store configuration and not something to rely on.
 *
 * ── Unconfigured is a supported state ──
 *
 * With no token, uploads fail with a clear 503 and the rest of chat works exactly
 * as it did before attachments existed. Attachments are an enhancement, not a
 * dependency, so a missing env var must not turn a working thread into a 500.
 */

import { del, get, put } from "@vercel/blob";

function token(): string | null {
  return process.env.BLOB_READ_WRITE_TOKEN || null;
}

export function isBlobConfigured(): boolean {
  return !!token();
}

export interface StoredBlob {
  url: string;
  pathname: string;
}

/**
 * Stores bytes and returns where they went.
 *
 * ── The pathname is chosen here, never by the client ──
 *
 * `chat/<conversationId>/<random>-<filename>`. Two things that matters for:
 *
 *   - The conversation id is a prefix, so everything belonging to one thread can
 *     be listed and swept without consulting Postgres — useful precisely when
 *     Postgres and the store have drifted, which is the only time you need it.
 *   - `addRandomSuffix` means two people uploading `screenshot.png` to the same
 *     conversation do not collide, and one cannot overwrite the other's file by
 *     picking the same name. Without it, "upload" would be "upsert".
 *
 * The filename is sanitised before it gets here (`safeFilename`), so no path
 * separator from a user can extend the prefix.
 */
export async function putAttachment(input: {
  conversationId: string;
  filename: string;
  contentType: string;
  body: Buffer;
}): Promise<StoredBlob | null> {
  const auth = token();
  if (!auth) return null;

  const result = await put(`chat/${input.conversationId}/${input.filename}`, input.body, {
    // Not a choice: this store refuses "public" outright. Stated explicitly so
    // that a future store misconfigured as public still gets private objects.
    access: "private",
    addRandomSuffix: true,
    contentType: input.contentType,
    token: auth,
  });

  return { url: result.url, pathname: result.pathname };
}

/**
 * Opens a stored blob for reading, as a stream.
 *
 * A stream and not a buffer, deliberately. A 25 MB PDF read into memory is 25 MB
 * of function memory held for the whole response; piping it through costs a
 * constant amount however large the file is. It is also the difference between a
 * download starting immediately and starting after the whole file has been
 * fetched from the store.
 */
export async function readAttachment(pathname: string): Promise<{
  stream: ReadableStream;
  contentType: string | null;
  size: number | null;
} | null> {
  const auth = token();
  if (!auth) return null;

  const found = await get(pathname, { access: "private", token: auth });
  if (!found) return null;

  return {
    stream: found.stream as ReadableStream,
    contentType: found.blob?.contentType ?? null,
    size: found.blob?.size ?? null,
  };
}

/**
 * Removes stored bytes.
 *
 * Never throws. It is called while cleaning up — after a database row has already
 * gone, or from the retention sweep — and a failure to delete is a bill, not a
 * correctness problem. Throwing here would turn "the file could not be removed"
 * into "the message could not be deleted", which is much worse. The orphan sweep
 * is what eventually catches whatever this misses.
 */
export async function deleteAttachment(urlOrPathname: string): Promise<boolean> {
  const auth = token();
  if (!auth) return false;

  try {
    await del(urlOrPathname, { token: auth });
    return true;
  } catch (err) {
    console.error(`[blob] failed to delete ${urlOrPathname}:`, (err as Error).message);
    return false;
  }
}
