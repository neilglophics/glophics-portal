/**
 * The session cookie.
 *
 * Two things here were outright bugs in the previous version:
 *
 *   * `decodeURIComponent` was called on every cookie value without a guard.
 *     A request carrying `sm_session=%zz` throws a URIError synchronously out
 *     of the request listener, which is an uncaught exception, which ends the
 *     process. One malformed cookie, sent by anyone who could reach the port,
 *     stopped the server.
 *
 *   * `Secure` was omitted unconditionally with a comment explaining that the
 *     server speaks plain HTTP on a LAN. True, and a reason for a default --
 *     not a reason to make it unreachable behind TLS. It is now decided per
 *     request, with an override.
 */

const { config } = require("../config.js");

const COOKIE_NAME = "sm_session";
// Behind TLS the cookie is issued under the __Host- prefix as well, which the
// browser refuses to accept unless it is Secure, path-scoped to / and carries
// no Domain -- closing off cookie-shadowing from a sibling subdomain.
const HOST_COOKIE_NAME = "__Host-sm_session";

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch (err) {
      // A malformed escape is not a reason to stop serving. Keep the raw value:
      // a session token is base64url and never needs decoding anyway, so this
      // still resolves a legitimate cookie that merely looks odd.
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Whether this particular request arrived over TLS.
 *
 * `X-Forwarded-Proto` is only consulted when the deployment has said it is
 * behind a proxy -- the same gate the IP allowlist already applies to
 * `X-Forwarded-For`. Trusting it unconditionally would let any client assert
 * https, and, worse in the other direction, let a plain-HTTP attacker suppress
 * the Secure flag by asserting http.
 */
function requestIsSecure(req, { trustProxy = false } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (trustProxy) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    return proto.toLowerCase() === "https";
  }
  return false;
}

function cookieSecure(req, options) {
  if (config.cookieSecure === "true") return true;
  if (config.cookieSecure === "false") return false;
  return requestIsSecure(req, options);
}

/** The cookie name to read first. Both are accepted, so turning TLS on does not
 *  sign everybody out. */
function readToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[HOST_COOKIE_NAME] || cookies[COOKIE_NAME] || null;
}

function attributes({ secure, maxAge }) {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

/**
 * The Set-Cookie header(s) that establish a session.
 *
 * Returns an array because behind TLS both names are set: the __Host- one is
 * what the browser will send back, and the plain one keeps a deployment that
 * flips TLS off again from stranding every open tab.
 */
function setSession(req, token, maxAgeSeconds, options) {
  const secure = cookieSecure(req, options);
  const headers = [`${COOKIE_NAME}=${token}; ${attributes({ secure, maxAge: maxAgeSeconds })}`];
  if (secure) {
    headers.unshift(`${HOST_COOKIE_NAME}=${token}; ${attributes({ secure: true, maxAge: maxAgeSeconds })}`);
  }
  return headers;
}

/**
 * Clearing must repeat every attribute except Max-Age, or the browser treats it
 * as a different cookie and leaves the original in place. Both names are
 * cleared regardless of the current TLS state, because the cookie being cleared
 * may have been set under the other one.
 */
function clearSession(req, options) {
  const secure = cookieSecure(req, options);
  return [
    `${COOKIE_NAME}=; ${attributes({ secure, maxAge: 0 })}`,
    `${HOST_COOKIE_NAME}=; ${attributes({ secure: true, maxAge: 0 })}`
  ];
}

module.exports = {
  COOKIE_NAME, HOST_COOKIE_NAME,
  parseCookies, readToken, setSession, clearSession, cookieSecure, requestIsSecure
};
