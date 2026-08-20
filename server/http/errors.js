/**
 * The vocabulary services use to refuse.
 *
 * Services must not know about status codes, and routes must not have to guess
 * why a service said no. These types are the contract between them: a service
 * throws one of these, and `toResponse` below is the single place that decides
 * what that means over HTTP.
 *
 * Anything else that reaches a route is a bug, and is reported as a 500 with a
 * message the user cannot act on -- deliberately, because a message they could
 * act on would be leaking an internal detail.
 */

class AppError extends Error {
  constructor(message, { status, code, expose = true, details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

/**
 * The input was wrong in a way the user can fix. Carries a list, because every
 * form in this application renders `errors[]` as a bullet list and has since
 * before this rewrite.
 */
class ValidationError extends AppError {
  constructor(errors, { code = "invalid" } = {}) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list[0] || "That input is not valid.", { status: 400, code });
    this.errors = list;
  }
}

class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(message, { status: 404, code: "not-found" });
  }
}

/** Authenticated, but not permitted. */
class ForbiddenError extends AppError {
  constructor(message, { code = "forbidden", needs = null } = {}) {
    super(message, { status: 403, code });
    this.needs = needs;
  }
}

/** Not authenticated, or no longer authenticated. */
class UnauthorizedError extends AppError {
  constructor(message = "Sign in to continue.", { code = "unauthenticated" } = {}) {
    super(message, { status: 401, code });
  }
}

/** The request was valid but the world has moved: a duplicate, or a stale write. */
class ConflictError extends AppError {
  constructor(message, { code = "conflict", details = null } = {}) {
    super(message, { status: 409, code, details });
  }
}

/** A dependency this server needs is not answering. */
class UnavailableError extends AppError {
  constructor(message = "The service is temporarily unavailable.", { code = "unavailable" } = {}) {
    super(message, { status: 503, code });
  }
}

/**
 * Turns any thrown value into the body and status to send.
 *
 * Every response keeps the `{ ok: false, error }` shape the browser has always
 * read, and validation adds `errors[]` on top of it -- so this rewrite is
 * invisible to the error rendering already in the UI.
 */
function toResponse(err) {
  if (err instanceof ValidationError) {
    return { status: 400, body: { ok: false, error: err.message, errors: err.errors, code: err.code } };
  }
  if (err instanceof ForbiddenError) {
    const body = { ok: false, error: err.message, code: err.code };
    if (err.needs) body.needs = err.needs;
    return { status: 403, body };
  }
  if (err instanceof AppError && err.expose) {
    const body = { ok: false, error: err.message, code: err.code };
    if (err.details) Object.assign(body, err.details);
    return { status: err.status, body };
  }
  return {
    status: 500,
    body: { ok: false, error: "Something went wrong on the server.", code: "internal" }
  };
}

/** True when the error is the caller's fault and not worth a stack trace. */
function isExpected(err) {
  return err instanceof AppError && err.expose && err.status < 500;
}

module.exports = {
  AppError, ValidationError, NotFoundError, ForbiddenError,
  UnauthorizedError, ConflictError, UnavailableError,
  toResponse, isExpected
};
