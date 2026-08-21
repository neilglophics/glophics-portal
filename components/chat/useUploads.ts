"use client";

import { useCallback, useRef, useState } from "react";
import { realtimeHeaders } from "@/lib/realtime/client";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  validateAttachment,
} from "@/lib/chat/attachments";
import type { StagedFile } from "./Attachments";
import type { AttachmentView } from "@/lib/db/queries/attachments";

/**
 * The composer's upload tray.
 *
 * ── Why XMLHttpRequest and not fetch ──
 *
 * `fetch` cannot report **upload** progress. It resolves when the response starts,
 * which for a 20 MB file on a slow connection is the entire wait, reported as a
 * single event at the end. `XMLHttpRequest.upload.onprogress` is still the only
 * way to draw a bar that moves, and a bar that moves is the difference between an
 * upload and an apparent hang. Everything else in this app uses `fetch`; this is
 * the one place where the older API does something the newer one cannot.
 *
 * ── Files upload the moment they are picked ──
 *
 * Not on send. The person has to be able to see the size, watch it go, and remove
 * it — all while they can still act on it. Deferring to the send means a failure
 * they cannot see and cannot cancel. The cost is a file that is stored and attached
 * to nothing if they never send, which the server models explicitly and sweeps;
 * see lib/db/queries/attachments.ts.
 */

interface UploadsApi {
  files: StagedFile[];
  /** Rejections from the picker — too big, wrong type, too many. Cleared on the
   *  next successful pick. */
  error: string | null;
  pick: (picked: File[]) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** After a successful send. Does NOT delete anything server-side — the message
   *  now owns those rows. */
  clear: () => void;
  /** The ids a send should claim. Only files that finished. */
  readyIds: string[];
  /** True while anything is still going up, so Send can be held back rather than
   *  sending a message whose files are not there yet. */
  busy: boolean;
}

function uploadOne(
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
  signal: { xhr: XMLHttpRequest | null },
): Promise<AttachmentView> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", file);

    const xhr = new XMLHttpRequest();
    signal.xhr = xhr;

    xhr.open("POST", `/api/chat/conversations/${conversationId}/attachments`);

    // The socket id, so the server can exclude this tab from any fan-out — the
    // same header every other mutation in the app sends.
    for (const [key, value] of Object.entries(realtimeHeaders())) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      // Capped at 99: the last percent belongs to the server's own work —
      // optimising the image and writing the row — and showing 100% while that is
      // still happening is a bar that finishes before the upload does.
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      let payload: { ok?: boolean; attachment?: AttachmentView; error?: string } = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        /* fall through to the generic message below */
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload.ok && payload.attachment) {
        resolve(payload.attachment);
      } else {
        // The server's own words when it gave any — it knows whether the problem
        // was the size, the type, or the optimiser being unreachable, and all
        // three have different fixes.
        reject(new Error(payload.error ?? `Upload failed (${xhr.status}).`));
      }
    };

    xhr.onerror = () => reject(new Error("Couldn't reach the server."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.ontimeout = () => reject(new Error("The upload timed out."));

    xhr.send(form);
  });
}

export function useUploads(conversationId: string): UploadsApi {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Two maps, and they have different lifetimes — which is the bug this shape
   * exists to avoid.
   *
   * `sources` holds the original `File` and lives until the file is removed or
   * sent. `inflight` holds the live request and lives only while it is going.
   * Keeping the File in the in-flight map meant a failed upload dropped it on
   * completion, so **retry could never find the file it was retrying** — browsers
   * do not let you reopen a file by name, so that path was dead.
   *
   * Refs and not state: neither is rendered, and putting them in state would
   * re-render the tray on every progress tick for no visible reason.
   */
  const sources = useRef(new Map<string, File>());
  const inflight = useRef(new Map<string, { xhr: XMLHttpRequest | null }>());
  /** Object URLs, revoked on removal. Each one pins its blob in memory until it
   *  is, and a session of dropping screenshots in would leak all of them. */
  const previews = useRef(new Map<string, string>());

  const start = useCallback(
    (key: string, file: File) => {
      const signal = { xhr: null as XMLHttpRequest | null };
      sources.current.set(key, file);
      inflight.current.set(key, signal);

      void uploadOne(
        conversationId,
        file,
        (percent) =>
          setFiles((prev) =>
            prev.map((f) => (f.key === key ? { ...f, progress: percent } : f)),
          ),
        signal,
      )
        .then((attachment) => {
          setFiles((prev) =>
            prev.map((f) =>
              f.key === key ? { ...f, status: "done", progress: 100, attachment } : f,
            ),
          );
        })
        .catch((err: Error) => {
          setFiles((prev) =>
            prev.map((f) =>
              f.key === key ? { ...f, status: "error", error: err.message } : f,
            ),
          );
        })
        .finally(() => {
          // Only the request. The File stays in `sources` so a retry has
          // something to send.
          inflight.current.delete(key);
        });
    },
    [conversationId],
  );

  /**
   * Accepts a pick from the file input.
   *
   * ── Everything happens OUTSIDE the state updater, deliberately ──
   *
   * This used to validate, create object URLs and kick off uploads from inside a
   * `setFiles(prev => ...)` callback. React state updaters must be pure, and with
   * `reactStrictMode` on they are invoked TWICE — so every picked file was
   * uploaded twice, staging two rows and two blobs for one file. The duplicate was
   * invisible in the tray, because the second render's return value replaced the
   * first's.
   *
   * So the decisions are made here, against `files` as of this render — which is
   * current, because a pick is a user event and events run between renders — and
   * the updater does nothing but append.
   */
  const pick = useCallback(
    (picked: File[]) => {
      setError(null);

      const room = ATTACHMENT_MAX_PER_MESSAGE - files.length;
      if (room <= 0) {
        setError(`${ATTACHMENT_MAX_PER_MESSAGE} files is the limit for one message.`);
        return;
      }

      const accepted: StagedFile[] = [];
      const rejected: string[] = [];

      for (const file of picked.slice(0, room)) {
        // The same check the route runs. Here only so a bad pick is reported
        // instantly rather than after the bytes have been sent; the server is what
        // enforces it.
        const verdict = validateAttachment({
          name: file.name,
          size: file.size,
          type: file.type || "",
        });
        if (!verdict.ok) {
          rejected.push(verdict.error);
          continue;
        }

        const key = crypto.randomUUID();
        // A local preview, so an image appears in the tray immediately rather than
        // after a round trip through the store.
        const localPreview = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined;
        if (localPreview) previews.current.set(key, localPreview);

        accepted.push({
          key,
          filename: file.name,
          bytes: file.size,
          mime: file.type,
          status: "uploading",
          progress: 0,
          localPreview,
        });
        start(key, file);
      }

      if (picked.length > room) {
        rejected.push(`Only ${room} more file${room === 1 ? "" : "s"} fit on this message.`);
      }
      // Reported together, one reason per rejected file, so somebody who dragged in
      // five and had two refused knows which two.
      if (rejected.length) setError(rejected.join(" "));

      if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
    },
    [files.length, start],
  );

  const remove = useCallback((key: string) => {
    // Abort a live upload rather than letting it finish into nothing. Without
    // this, removing a 20 MB file keeps uploading it and then stages a row the
    // composer has already forgotten — an orphan created deliberately.
    inflight.current.get(key)?.xhr?.abort();
    inflight.current.delete(key);
    sources.current.delete(key);

    const preview = previews.current.get(key);
    if (preview) {
      URL.revokeObjectURL(preview);
      previews.current.delete(key);
    }

    setFiles((prev) => {
      const found = prev.find((f) => f.key === key);
      // Already staged server-side, so the row and its bytes have to go too.
      // Fire-and-forget: the sweep collects it if this fails, and blocking the UI
      // on a cleanup nobody is waiting for would be worse.
      if (found?.attachment) {
        void fetch(`/api/chat/attachments/${found.attachment.id}`, {
          method: "DELETE",
          headers: realtimeHeaders(),
        }).catch(() => {});
      }
      return prev.filter((f) => f.key !== key);
    });
    setError(null);
  }, []);

  const retry = useCallback(
    (key: string) => {
      const original = sources.current.get(key);

      if (!original) {
        // Should not happen — `sources` outlives every attempt — but a browser
        // cannot reopen a file by name, so if it ever does the only honest thing
        // is to say so rather than to retry nothing and show a bar that never
        // moves.
        setFiles((prev) =>
          prev.map((f) =>
            f.key === key ? { ...f, status: "error", error: "Pick the file again to retry." } : f,
          ),
        );
        return;
      }

      setFiles((prev) =>
        prev.map((f) =>
          f.key === key ? { ...f, status: "uploading", progress: 0, error: undefined } : f,
        ),
      );
      start(key, original);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const url of previews.current.values()) URL.revokeObjectURL(url);
    previews.current.clear();
    sources.current.clear();
    inflight.current.clear();
    setFiles([]);
    setError(null);
  }, []);

  return {
    files,
    error,
    pick,
    remove,
    retry,
    clear,
    readyIds: files.flatMap((f) => (f.attachment ? [f.attachment.id] : [])),
    busy: files.some((f) => f.status === "uploading"),
  };
}
