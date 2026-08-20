/**
 * Writing responses.
 *
 * Every response leaves through here, which is what makes it possible to say
 * with confidence that the security headers are on all of them -- rather than
 * on the ones somebody remembered.
 */

const SECURITY_HEADERS = {
  // Stops a browser from second-guessing a Content-Type, which is how a JSON
  // response ends up being executed as script.
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin"
};

/**
 * The page's content policy.
 *
 * `'unsafe-inline'` is present and cannot currently be removed: index.html
 * loads Tailwind's browser build from a CDN, that build injects <style>
 * elements at runtime, and there is an inline theme script in the head. So this
 * is NOT an XSS defence and should not be described as one -- it is here for
 * frame-ancestors, object-src, base-uri and form-action, which it does enforce.
 * Vendoring Tailwind and moving the theme script to a file would let the rest
 * of it mean something.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

function baseHeaders(isApi) {
  const headers = { ...SECURITY_HEADERS };
  if (isApi) {
    // An authenticated JSON response has no business in a shared cache, or in
    // the browser's back-forward cache after a sign-out.
    headers["Cache-Control"] = "no-store";
  } else {
    headers["Content-Security-Policy"] = CSP;
  }
  return headers;
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...baseHeaders(true),
    ...extraHeaders
  });
  res.end(payload);
}

function sendText(res, statusCode, text, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...baseHeaders(false),
    ...extraHeaders
  });
  res.end(text);
}

function sendNoContent(res, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(204, { ...baseHeaders(true), ...extraHeaders });
  res.end();
}

module.exports = { sendJson, sendText, sendNoContent, baseHeaders, SECURITY_HEADERS, CSP };
