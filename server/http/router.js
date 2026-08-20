/**
 * Matching a request to a route, and proving the table is sound before the
 * server accepts a single connection.
 *
 * The failure mode of a hand-rolled router is a handler somebody forgot to put
 * a permission check in front of. The previous version repeated
 * `if (!allows(res, user, "…")) return true;` inside each branch -- correct, but
 * one copy-paste away from not being. Here the requirement is a field on the
 * route, and a route that declares neither a capability nor `public: true`
 * throws at startup. You cannot forget it, because forgetting it means the
 * process does not run.
 */

const { ALL_CAPABILITIES } = require("../../shared/data.js");

/** "/api/auth/users/:id/password" -> segments, marking which are parameters. */
function compile(path) {
  const segments = path.split("/").filter(Boolean).map((segment) => (
    segment.startsWith(":")
      ? { param: segment.slice(1) }
      : { literal: segment }
  ));
  return { path, segments };
}

function matchPath(compiled, urlSegments) {
  if (compiled.segments.length !== urlSegments.length) return null;
  const params = {};
  for (let i = 0; i < compiled.segments.length; i += 1) {
    const segment = compiled.segments[i];
    const value = urlSegments[i];
    if (segment.literal !== undefined) {
      if (segment.literal !== value) return null;
    } else {
      if (!value) return null;
      params[segment.param] = decodeURIComponent(value);
    }
  }
  return params;
}

class Router {
  constructor(routes) {
    this.routes = routes.map((route) => ({ ...route, compiled: compile(route.path) }));
    this.assertSound();
  }

  /**
   * Every route must declare exactly one access rule. Anything else is a
   * programming error, and it is caught here rather than in production.
   */
  assertSound() {
    const seen = new Set();
    for (const route of this.routes) {
      const label = `${route.method} ${route.path}`;

      if (seen.has(label)) {
        throw new Error(`Route table declares ${label} twice.`);
      }
      seen.add(label);

      const rules = [
        route.public === true,
        typeof route.capability === "string",
        route.authenticated === true
      ].filter(Boolean).length;

      if (rules !== 1) {
        throw new Error(
          `Route ${label} must declare exactly one of: public: true, ` +
          "capability: \"<name>\", or authenticated: true."
        );
      }

      if (route.capability && !ALL_CAPABILITIES.includes(route.capability)) {
        throw new Error(
          `Route ${label} requires capability "${route.capability}", which is not ` +
          `one of: ${ALL_CAPABILITIES.join(", ")}.`
        );
      }

      if (typeof route.handler !== "function") {
        throw new Error(`Route ${label} has no handler function.`);
      }
    }
  }

  /** @returns {{route, params}|null} */
  match(method, pathname) {
    const segments = pathname.split("/").filter(Boolean);
    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchPath(route.compiled, segments);
      if (params === null) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }

    // Distinguishing "no such path" from "wrong verb for this path" turns a
    // silent 404 during development into an accurate 405.
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  /** Every method registered for a path, for the Allow header on a 405. */
  allowedMethods(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    const methods = new Set();
    for (const route of this.routes) {
      if (matchPath(route.compiled, segments) !== null) methods.add(route.method);
    }
    return [...methods];
  }
}

module.exports = { Router, compile, matchPath };
