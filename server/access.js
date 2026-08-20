/**
 * Who is calling, and whether they may.
 *
 * Credentials and sessions live in auth-store.js (config/auth.json), never in
 * the board — so nothing here is ever broadcast over SSE. Every /api/ route
 * except the sign-in handshake runs through currentUser() first, and each one
 * names the capability it needs; roleCan() is the same function the browser
 * uses to decide what to show, so the two cannot disagree.
 */

const Auth = require("./auth-store.js");
const { sendJson } = require("./http.js");

const SESSION_COOKIE = "sm_session";

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// HttpOnly so no script can read the token, SameSite=Lax so another site
// can't ride the session. `Secure` is deliberately not set: this server
// speaks plain http on a LAN or a Live Share port. Behind TLS, add it.
function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function currentUser(req) {
  return Auth.userForToken(parseCookies(req)[SESSION_COOKIE]);
}

function denyCapability(res, user, capability) {
  sendJson(res, 403, {
    ok: false,
    error: `Your role (${user.role}) can't do that.`,
    needs: capability
  });
}

// Wraps a handler in a capability check. Returns true when the caller may
// proceed, and has already answered 403 when they may not.
function allows(res, user, capability) {
  if (Auth.roleCan(user.role, capability)) return true;
  denyCapability(res, user, capability);
  return false;
}

module.exports = { SESSION_COOKIE, parseCookies, sessionCookie, currentUser, denyCapability, allows };
