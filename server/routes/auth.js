/**
 * Signing in, signing out, who am I, and managing who may sign in at all.
 *
 * Every handler here is thin: parse the body, call one service, shape the
 * response. Cookie strings, permission checks and CSRF live in the pipeline,
 * not here.
 */

const cookies = require("../http/cookies.js");
const auth = require("../services/auth.service.js");
const authAdmin = require("../services/auth-admin.service.js");
const { AUTH_ROLES } = require("../../shared/data.js");
const { ValidationError } = require("../http/errors.js");

async function login(ctx) {
  const body = await ctx.readBody();
  const { user, session } = await auth.signIn({
    username: body.username,
    password: body.password,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
    ctx
  });

  const setCookie = cookies.setSession(ctx.req, session.token, Math.floor((session.expiresAt - Date.now()) / 1000));
  ctx.res.setHeader("Set-Cookie", setCookie);
  return { ok: true, user, roles: AUTH_ROLES, csrfToken: session.csrfToken };
}

async function logout(ctx) {
  await auth.signOut(ctx.sessionToken, ctx);
  ctx.res.setHeader("Set-Cookie", cookies.clearSession(ctx.req, { trustProxy: ctx.trustProxy }));
  return { ok: true };
}

/** Always 200 -- "not signed in" is the expected first answer on a cold load,
 *  not an error worth treating as one in the browser console. */
async function me(ctx) {
  const user = await auth.currentUser(ctx);
  const body = { ok: Boolean(user), user: user || null, roles: AUTH_ROLES };
  if (ctx.session) body.csrfToken = ctx.session.csrfToken;
  return body;
}

async function changeOwnPassword(ctx) {
  const body = await ctx.readBody();
  const { user, session } = await auth.changeOwnPassword(ctx, {
    currentPassword: body.currentPassword,
    newPassword: body.newPassword
  });

  const setCookie = cookies.setSession(ctx.req, session.token, Math.floor((session.expiresAt - Date.now()) / 1000));
  ctx.res.setHeader("Set-Cookie", setCookie);
  return { ok: true, user, csrfToken: session.csrfToken };
}

// ---------------------------------------------------- user management -----

async function listUsers() {
  const users = await authAdmin.list();
  return { ok: true, users, roles: AUTH_ROLES };
}

async function createUser(ctx) {
  const body = await ctx.readBody();
  const user = await authAdmin.create(ctx, body);
  return { ok: true, user };
}

async function updateUser(ctx) {
  const body = await ctx.readBody();
  const user = await authAdmin.update(ctx, ctx.params.id, body);
  return { ok: true, user };
}

async function removeUser(ctx) {
  return authAdmin.remove(ctx, ctx.params.id);
}

async function resetPassword(ctx) {
  const body = await ctx.readBody();
  if (!body.password) throw new ValidationError(["Enter a password."]);
  return authAdmin.resetPassword(ctx, ctx.params.id, body.password);
}

module.exports = {
  login, logout, me, changeOwnPassword,
  listUsers, createUser, updateUser, removeUser, resetPassword
};
