/**
 * The ordered chain every /api/ request runs through.
 *
 * Order is the security property here, so it is written once, in one list, and
 * each stage says why it sits where it does:
 *
 *   1. address       cheapest rejection, and the one that must work even when
 *                    the database does not.
 *   2. session       everything below needs to know who is asking.
 *   3. csrf          before authorization, so a forged request never reaches
 *                    the permission check and never pollutes its audit trail.
 *   4. password      a login that must change its password may do three things
 *                    and nothing else, enforced here rather than in the browser.
 *   5. capability    the actual permission.
 *   6. handler
 */

const { config } = require("../config.js");
const { roleCan } = require("../../shared/data.js");
const cookies = require("./cookies.js");
const csrf = require("./csrf.js");
const { readJson } = require("./body.js");
const {
  UnauthorizedError, ForbiddenError, AppError, toResponse, isExpected
} = require("./errors.js");
const sessionService = require("../services/session.service.js");
const audit = require("../services/audit.service.js");

/** Routes a login may still reach while it is required to change its password. */
const ALLOWED_WHILE_MUST_CHANGE = new Set([
  "auth.me", "auth.password", "auth.logout"
]);

/**
 * Everything a handler is given, and the only thing it is given.
 *
 * Assembling it here means a handler cannot reach for `req` to do something the
 * pipeline was supposed to have decided.
 */
function createContext(req, res, { clientIp, trustProxy }) {
  return {
    req,
    res,
    method: req.method,
    url: req.url,
    pathname: req.url.split("?")[0],
    query: new URL(req.url, "http://internal").searchParams,
    params: {},
    clientIp,
    trustProxy,
    userAgent: req.headers["user-agent"] || null,
    // Echoed back on the event a write produces, so the tab that made the
    // change can recognise its own echo.
    clientId: req.headers["x-client-id"] || null,
    user: null,
    session: null,
    route: null,
    body: null,
    /** Lazily read, so routes that take no body never pay for one. */
    async readBody() {
      if (this.body === null) this.body = await readJson(this.req);
      return this.body;
    }
  };
}

async function resolveSession(ctx) {
  const token = cookies.readToken(ctx.req);
  if (!token) return;
  const resolved = await sessionService.resolve(token);
  if (!resolved) return;
  ctx.session = resolved.session;
  ctx.user = resolved.user;
  ctx.sessionToken = token;
}

function requireAuthenticated(ctx) {
  if (!ctx.user) throw new UnauthorizedError();
}

function requireCapability(ctx, capability) {
  if (roleCan(ctx.user.role, capability)) return;
  audit.queue(audit.EVENTS.AUTHZ_DENIED, ctx, {
    outcome: "failure",
    detail: { capability, route: ctx.route.path }
  });
  // Message and `needs` field are unchanged from the previous implementation,
  // because the interface renders both.
  throw new ForbiddenError(`Your role (${ctx.user.role}) can't do that.`, {
    code: "forbidden",
    needs: capability
  });
}

function requirePasswordCurrent(ctx) {
  if (!ctx.user || !ctx.user.mustChangePassword) return;
  if (ALLOWED_WHILE_MUST_CHANGE.has(ctx.route.id)) return;
  throw new ForbiddenError("Set a new password before continuing.", {
    code: "password-change-required"
  });
}

/**
 * Runs one matched route through the chain.
 *
 * Returns the handler's value, which the caller serialises. Throws an AppError
 * for anything the caller did wrong.
 */
async function run(ctx, route, params) {
  ctx.route = route;
  ctx.params = params;

  await resolveSession(ctx);

  csrf.verify(
    ctx.req,
    { session: ctx.session, exemptToken: route.csrf === "origin-only" },
    { trustProxy: ctx.trustProxy }
  );

  if (!route.public) {
    requireAuthenticated(ctx);
    requirePasswordCurrent(ctx);
    if (route.capability) requireCapability(ctx, route.capability);
  }

  return route.handler(ctx);
}

module.exports = {
  createContext, run, resolveSession,
  requireAuthenticated, requireCapability, requirePasswordCurrent,
  toResponse, isExpected, AppError
};
