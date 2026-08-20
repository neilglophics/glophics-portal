/**
 * Cross-site request forgery.
 *
 * Two gates, because neither is sufficient alone in this deployment:
 *
 *   Origin gate. `Sec-Fetch-Site` first (set by the browser, unforgeable by
 *   script, and unambiguous), falling back to `Origin` then `Referer`. Fails
 *   closed. This is what protects the sign-in request, which by definition has
 *   no session and therefore no token yet.
 *
 *   Token gate. A random value minted with the session, held in the database,
 *   returned to the page, and required back as a header. This is what protects
 *   everything else.
 *
 * A double-submit cookie was the other candidate and is the wrong choice here
 * specifically: its security rests on the attacker being unable to set a cookie
 * on this origin, and this application is explicitly designed to run over plain
 * HTTP on a LAN and through tunnels -- exactly the conditions where that
 * assumption fails.
 */

const crypto = require("node:crypto");
const { config } = require("../config.js");
const { ForbiddenError } = require("./errors.js");
const { requestIsSecure } = require("./cookies.js");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HEADER = "x-csrf-token";

function mintToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function expectedOrigin(req, options) {
  if (config.appOrigin) return config.appOrigin.replace(/\/+$/, "");
  const host = req.headers.host;
  if (!host) return null;
  return `${requestIsSecure(req, options) ? "https" : "http"}://${host}`;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch (err) {
    return null;
  }
}

/**
 * @returns true when the request demonstrably came from this origin.
 */
function checkOrigin(req, options) {
  // Set by every current browser on every request, and not settable by script.
  // "none" means a direct navigation (typed URL, bookmark), which cannot be a
  // forgery because no other site was involved.
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const expected = expectedOrigin(req, options);
  if (!expected) return false;

  if (req.headers.origin) return req.headers.origin === expected;

  const referer = req.headers.referer;
  if (referer) {
    const parsed = safeUrl(referer);
    return Boolean(parsed) && parsed.origin === expected;
  }

  // No Sec-Fetch-Site, no Origin, no Referer, on a state-changing request.
  // Fail closed: a browser sends at least one of these.
  return false;
}

function checkToken(req, session) {
  if (!session) return true; // nothing to protect yet; the origin gate covers it
  const supplied = req.headers[HEADER];
  if (typeof supplied !== "string" || !supplied) return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(session.csrfToken || "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The pipeline layer. Runs on every state-changing request under /api/.
 *
 * `GET /api/events` is exempt from the token gate and cannot be otherwise:
 * EventSource cannot set headers. It is safe because the server sends no
 * cross-origin headers at all, so another site can open the stream but can
 * never read a byte of it. The origin gate still applies.
 */
function verify(req, { session, exemptToken = false }, options) {
  if (SAFE_METHODS.has(req.method)) return;

  if (!checkOrigin(req, options)) {
    throw new ForbiddenError(
      "This request could not be verified. Reload the page and try again.",
      { code: "csrf" }
    );
  }

  if (!exemptToken && !checkToken(req, session)) {
    throw new ForbiddenError(
      "This request could not be verified. Reload the page and try again.",
      { code: "csrf" }
    );
  }
}

module.exports = { verify, checkOrigin, checkToken, mintToken, expectedOrigin, HEADER, SAFE_METHODS };
