/**
 * Signing in, signing out, who am I, and managing who may sign in at all.
 *
 * The first three are the only part of the API a stranger reaches — every
 * other route in the app has already resolved a session before it is called.
 * Everything under /api/auth/users needs `manage-users`.
 */

const Auth = require("../auth-store.js");
const { sendJson, readBody } = require("../http.js");
const { SESSION_COOKIE, parseCookies, sessionCookie, currentUser, allows } = require("../access.js");

async function handleLogin(req, res) {
  try {
    const { username, password } = await readBody(req);
    const result = Auth.signIn(username, password);
    if (!result.ok) {
      sendJson(res, 401, { ok: false, error: result.error });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": sessionCookie(result.token, result.maxAgeSeconds)
    });
    res.end(JSON.stringify({ ok: true, user: result.user }));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: "Couldn't read that sign-in request." });
  }
}

function handleLogout(req, res) {
  Auth.signOut(parseCookies(req)[SESSION_COOKIE]);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  });
  res.end(JSON.stringify({ ok: true }));
}

// Answers 200 either way — "not signed in" is the expected first answer on
// a cold load, not an error worth logging in the browser console.
function handleMe(req, res) {
  const user = currentUser(req);
  sendJson(res, 200, { ok: !!user, user: user || null, roles: Auth.AUTH_ROLES });
}

async function handleChangeOwnPassword(req, res, user) {
  try {
    const { currentPassword, newPassword } = await readBody(req);
    const result = Auth.changeOwnPassword(user.id, currentPassword, newPassword);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    // Changing a password drops every session that user had, this one
    // included — hand back a fresh cookie so they aren't signed out of the
    // tab they just used to change it.
    const reissued = Auth.signIn(user.username, newPassword);
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (reissued.ok) headers["Set-Cookie"] = sessionCookie(reissued.token, reissued.maxAgeSeconds);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    sendJson(res, 400, { ok: false, errors: ["Couldn't read that request."] });
  }
}

// ---------- user management (manage-users) ----------

async function handleUsersRoute(req, res, url, user) {
  if (!allows(res, user, "manage-users")) return;

  if (url === "/api/auth/users" && req.method === "GET") {
    sendJson(res, 200, { ok: true, users: Auth.listUsers(), roles: Auth.AUTH_ROLES });
    return;
  }
  if (url === "/api/auth/users" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) { sendJson(res, 400, { ok: false, errors: ["Couldn't read that request."] }); return; }
    const result = Auth.createUser(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  const passwordMatch = url.match(/^\/api\/auth\/users\/([^/]+)\/password$/);
  if (passwordMatch && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) { sendJson(res, 400, { ok: false, errors: ["Couldn't read that request."] }); return; }
    const result = Auth.setPassword(decodeURIComponent(passwordMatch[1]), body.password);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  const oneMatch = url.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (oneMatch && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) { sendJson(res, 400, { ok: false, errors: ["Couldn't read that request."] }); return; }
    const result = Auth.updateUser(decodeURIComponent(oneMatch[1]), body, user.id);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  if (oneMatch && req.method === "DELETE") {
    const result = Auth.deleteUser(decodeURIComponent(oneMatch[1]), user.id);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "No such user route." });
}

// The handshake: no session required, because these are how you get one.
function routePublic(req, res, url) {
  if (url === "/api/auth/login" && req.method === "POST") { handleLogin(req, res); return true; }
  if (url === "/api/auth/logout" && req.method === "POST") { handleLogout(req, res); return true; }
  if (url === "/api/auth/me" && req.method === "GET") { handleMe(req, res); return true; }
  return false;
}

function route(req, res, url, user) {
  if (url === "/api/auth/password" && req.method === "POST") {
    handleChangeOwnPassword(req, res, user);
    return true;
  }
  if (url.startsWith("/api/auth/users")) {
    handleUsersRoute(req, res, url, user)
      .catch(() => sendJson(res, 500, { ok: false, error: "User request failed." }));
    return true;
  }
  return false;
}

module.exports = { routePublic, route };
