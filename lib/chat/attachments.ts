/**
 * What may be attached to a message, how big, and how it is described.
 *
 * ── One list, enforced twice ──
 *
 * `ACCEPTED` is read by the file picker in the browser AND by the upload route —
 * the same shape as `AUTH_ROLES` and `REACTION_EMOJI`. **What the picker offers is
 * courtesy; the route is the boundary.** A file that slips past the picker's
 * `accept` attribute (which is a hint, not a control — you can always choose "All
 * files") is refused server-side by the same table.
 *
 * Safe to import from a client component: nothing here touches the database or the
 * blob store.
 */

/** 25 MB. The database CHECK sits at exactly this, as a backstop for a route that
 *  stopped checking rather than as the limit itself. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** How many files one message may carry. A bound on the fan-out of a single send
 *  more than on storage: each one is a row, an upload and a proxy route to serve. */
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

/**
 * How this app classifies a file, which is the only thing the UI actually needs
 * to know. Three renderings, not thirty:
 *
 *   image  a thumbnail in the bubble, and a lightbox on click
 *   pdf    a file card that opens inline in a new tab — browsers render PDFs
 *   file   a file card that downloads
 */
export type AttachmentKind = "image" | "pdf" | "file";

interface AcceptedType {
  mime: string;
  /** Shown on the file card. "PDF", not "application/pdf" — nobody reads mime
   *  types for pleasure. */
  label: string;
  kind: AttachmentKind;
}

/**
 * The allowlist.
 *
 * ── Why an allowlist and not a denylist ──
 *
 * A denylist of dangerous types is a list you are always one entry behind on. This
 * is a coordination board: screenshots, logs, specs and spreadsheets cover what
 * people actually share, and anything outside it can go through a channel that was
 * designed to carry it.
 *
 * Note what is NOT here, deliberately: no `.zip`, no `.exe`, nothing executable,
 * and no `image/svg+xml`. **SVG is a script container** — it can carry
 * `<script>` and would execute in the origin that serves it, which for us is the
 * origin holding everybody's session cookie. It looks like an image and is not
 * one.
 */
export const ACCEPTED: readonly AcceptedType[] = [
  { mime: "image/png", label: "PNG", kind: "image" },
  { mime: "image/jpeg", label: "JPEG", kind: "image" },
  { mime: "image/webp", label: "WebP", kind: "image" },
  { mime: "image/gif", label: "GIF", kind: "image" },
  { mime: "image/avif", label: "AVIF", kind: "image" },
  { mime: "application/pdf", label: "PDF", kind: "pdf" },
  { mime: "text/plain", label: "Text", kind: "file" },
  { mime: "text/csv", label: "CSV", kind: "file" },
  { mime: "application/json", label: "JSON", kind: "file" },
  { mime: "application/msword", label: "Word", kind: "file" },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
    kind: "file",
  },
  { mime: "application/vnd.ms-excel", label: "Excel", kind: "file" },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel",
    kind: "file",
  },
  { mime: "application/vnd.ms-powerpoint", label: "PowerPoint", kind: "file" },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPoint",
    kind: "file",
  },
] as const;

/** The `accept` attribute for the file input. A hint to the picker, nothing more. */
export const ACCEPT_ATTRIBUTE = ACCEPTED.map((t) => t.mime).join(",");

export function acceptedType(mime: string): AcceptedType | null {
  return ACCEPTED.find((t) => t.mime === mime) ?? null;
}

export function isAcceptedMime(value: unknown): boolean {
  return typeof value === "string" && !!acceptedType(value);
}

/** Images are the only kind that gets a thumbnail and a lightbox. */
export function attachmentKind(mime: string): AttachmentKind {
  return acceptedType(mime)?.kind ?? "file";
}

export function typeLabel(mime: string): string {
  // Falls back to the subtype rather than the whole mime string: a row that
  // somehow holds an unlisted type still reads as "XLSB" rather than as
  // "application/vnd.ms-excel.sheet.binary.macroEnabled.12".
  return acceptedType(mime)?.label ?? (mime.split("/")[1] ?? "File").toUpperCase();
}

/**
 * Validates one file before it is uploaded.
 *
 * Returns a message rather than a boolean, because every rejection here is
 * something a person has to act on and "invalid file" tells them nothing about
 * which of their three files is the problem.
 *
 * Called by the browser so a bad pick is reported instantly, and by the route
 * because that is the check that counts.
 */
export function validateAttachment(file: {
  name: string;
  size: number;
  type: string;
}): { ok: true } | { ok: false; error: string } {
  if (!file.size) {
    return { ok: false, error: `“${file.name}” is empty.` };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: `“${file.name}” is ${formatBytes(file.size)}. The limit is ${formatBytes(
        ATTACHMENT_MAX_BYTES,
      )}.`,
    };
  }
  if (!isAcceptedMime(file.type)) {
    // Names the type it saw. "Can't attach that" leaves somebody guessing whether
    // the problem is the file, the size, or the app.
    return {
      ok: false,
      error: `“${file.name}” is a ${file.type || "unknown"} file, which can't be attached. Images, PDFs, and Office or text documents can.`,
    };
  }
  return { ok: true };
}

/**
 * "1.4 MB". Base 1024 with decimal labels, which is what every operating system
 * shows, so the number here matches the number in their file manager.
 *
 * One decimal place below 10 and none above, so "9.4 MB" keeps its precision and
 * "1013 KB" does not pretend to.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * C0 control characters and DEL.
 *
 * Built with `\u` escapes rather than written as a regex literal on purpose: a
 * literal here would put real control bytes into this source file, which makes it
 * a binary file to git and to grep, and makes this line impossible to review.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Strips a submitted filename down to something safe to store and to echo back in
 * a `Content-Disposition` header.
 *
 * Three separate hazards, and all three are real:
 *
 *   - **Path traversal.** A browser sends only a basename, but this value also
 *     arrives from `fetch` calls we do not control. `../../etc/passwd` must not
 *     survive, so every separator goes.
 *   - **Header injection.** A CR or LF in a header value can end the header and
 *     start another. Control characters go.
 *   - **Length.** The column is bounded at 255; truncating here keeps the
 *     extension, because a file that arrives as `report` instead of
 *     `report.xlsx` will not open.
 */
export function safeFilename(input: unknown): string {
  const raw = String(input ?? "");

  // The ORDER of these matters, and getting it wrong leaves debris rather than a
  // hole: stripping leading dots before flattening the separators turns
  // "../../etc/passwd" into "_.._etc_passwd" — safe, since no separator survives,
  // but a name nobody would recognise.
  const cleaned = raw
    // 1. C0 controls and DEL. This is the header-injection half: a CR or an LF
    //    inside a header value can terminate that header and begin another.
    .replace(CONTROL_CHARS, "")
    // 2. Both separators, so a Windows path is handled as well as a POSIX one.
    //    After this line the value cannot address a directory at all.
    .replace(/[\\/]/g, "_")
    // 3. Collapse runs of dots. A single dot separates a name from its extension;
    //    a run of them is only ever the remains of a traversal attempt.
    .replace(/\.{2,}/g, ".")
    // 4. Strip whatever leading punctuation the steps above left behind, so
    //    "../../etc/passwd" ends up as "etc_passwd" rather than "._._etc_passwd".
    //    Also catches a name that was nothing but separators.
    .replace(/^[._]+/, "")
    .trim();

  if (!cleaned) return "file";
  if (cleaned.length <= 200) return cleaned;

  // Keep the extension. Truncating the tail is what turns a spreadsheet into
  // something the operating system cannot open.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 200 - ext.length) + ext;
}

/**
 * The one-line description of what a message carries, for the conversation list
 * preview and for a reply chip pointing at an attachment-only message.
 *
 * Prefers the text: somebody who wrote a sentence and attached a screenshot meant
 * the sentence to be the summary.
 */
export function attachmentSummary(
  body: string,
  attachments: readonly { mime: string; filename: string }[],
): string {
  if (body.trim()) return body;
  if (!attachments.length) return "";

  if (attachments.length === 1) {
    const only = attachments[0]!;
    // ── An image is described, never named ──
    //
    // It used to read "Photo · test.webp". Everywhere this string appears next to
    // an image, a thumbnail of that image appears with it — so the filename was
    // saying, in worse form, what the picture already said. Worse than redundant
    // for an uploaded screenshot, whose name is usually a timestamp or the
    // optimiser's ".webp" rewrite rather than anything a person chose.
    //
    // A document keeps its name, because there is no thumbnail and the name is the
    // only thing identifying it: "spec.pdf" is the whole content of that quote,
    // and "File" would make it useless.
    return attachmentKind(only.mime) === "image" ? "Photo" : only.filename;
  }

  const allImages = attachments.every((a) => attachmentKind(a.mime) === "image");
  return `${attachments.length} ${allImages ? "photos" : "files"}`;
}
