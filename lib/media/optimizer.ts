/**
 * The media optimiser at media-optimizer.eliesertajanlangit.com.
 *
 * ── The contract, established by probing the live service ──
 *
 *   POST /api/optimize   multipart/form-data
 *     file    the image
 *     options a JSON string
 *
 * Every one of these options is REQUIRED — the endpoint validates with Zod and
 * rejects a partial payload rather than defaulting. That is why the object below
 * is built whole every time instead of spreading a caller's partial over
 * defaults: a missing key is a 400, not a fallback.
 *
 *   format            "webp" | "avif" | "jpeg" | "png" | "gif" | "tiff" | "original"
 *   compressionMode   "balanced" | "lossy" | "lossless"
 *   quality           number
 *   stripMetadata     boolean
 *   progressive       boolean
 *   chromaSubsampling boolean
 *   resizeFit         "inside" | "cover" | "fill"
 *   maxWidth/maxHeight  optional numbers
 *
 * It answers with the raw optimised bytes, and reports what it did in headers:
 * X-Original-Size, X-Processed-Size, X-Width, X-Height, X-Format.
 *
 * ── Why this runs on the server and not in the browser ──
 *
 * The service sends `Access-Control-Allow-Origin: *`, so a browser could call it
 * directly. It does not, for three reasons: the size and type limits have to be
 * enforced somewhere a user cannot edit; what gets stored must be known to be
 * the optimised output rather than whatever a client chose to send; and a
 * round trip through the browser would move the original file twice for nothing.
 *
 * ── It doubles as the validator ──
 *
 * libvips is what actually decodes the upload. A file that is not really an
 * image comes back as an error rather than as bytes, so a successful response is
 * itself proof the input was decodable — which is a stronger check than sniffing
 * a magic number and hoping.
 */

const ENDPOINT = "https://media-optimizer.eliesertajanlangit.com/api/optimize";

/** The service's own documented ceiling for images. Ours is lower; see AVATAR_MAX_BYTES. */
export const OPTIMIZER_MAX_BYTES = 4 * 1024 * 1024;

const TIMEOUT_MS = 30_000;

export interface OptimizeOptions {
  format: "webp" | "avif" | "jpeg" | "png" | "gif" | "tiff" | "original";
  compressionMode: "balanced" | "lossy" | "lossless";
  quality: number;
  stripMetadata: boolean;
  progressive: boolean;
  chromaSubsampling: boolean;
  resizeFit: "inside" | "cover" | "fill";
  maxWidth?: number;
  maxHeight?: number;
}

export interface OptimizeResult {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  originalSize: number;
  processedSize: number;
  format: string;
}

export type OptimizeOutcome =
  | { ok: true; result: OptimizeResult }
  | { ok: false; error: string };

/**
 * Settings for a profile picture.
 *
 * `stripMetadata` is not cosmetic — a photo straight off a phone carries EXIF,
 * and EXIF routinely carries GPS coordinates. Uploading an avatar should not
 * publish where it was taken.
 *
 * Re-encoding to WebP inside 256x256 also neutralises a polyglot file: whatever
 * was appended after the image data does not survive a decode and re-encode.
 */
export const AVATAR_OPTIONS: OptimizeOptions = {
  format: "webp",
  compressionMode: "balanced",
  quality: 82,
  stripMetadata: true,
  progressive: false,
  chromaSubsampling: false,
  // "inside" fits within the box without cropping, so nobody loses their head
  // to a square crop they did not choose.
  resizeFit: "inside",
  maxWidth: 256,
  maxHeight: 256,
};

export async function optimize(
  file: Blob,
  filename: string,
  options: OptimizeOptions,
): Promise<OptimizeOutcome> {
  const form = new FormData();
  form.set("file", file, filename);
  form.set("options", JSON.stringify(options));

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A refusal is better than storing something unoptimised: the stored bytes
    // would then carry EXIF and unbounded dimensions, which is the whole reason
    // for sending them through here.
    return {
      ok: false,
      error: `Couldn't reach the image optimiser (${(err as Error).message}). Try again in a moment.`,
    };
  }

  if (!response.ok) {
    // The service answers JSON errors; anything else is quoted back trimmed so
    // an HTML error page does not end up in a user-facing message.
    let detail = `optimiser answered ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* keep the status */
    }
    return { ok: false, error: `That image couldn't be processed: ${detail}` };
  }

  const mime = response.headers.get("content-type") ?? "";
  if (!mime.startsWith("image/")) {
    return { ok: false, error: "The optimiser returned something that is not an image." };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const int = (name: string, fallback: number) => {
    const raw = response.headers.get(name);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };

  return {
    ok: true,
    result: {
      bytes,
      mime,
      width: int("x-width", 0),
      height: int("x-height", 0),
      originalSize: int("x-original-size", file.size),
      processedSize: int("x-processed-size", bytes.length),
      format: response.headers.get("x-format") ?? mime.replace("image/", ""),
    },
  };
}
