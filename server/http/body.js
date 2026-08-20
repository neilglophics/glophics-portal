/**
 * Reading a JSON request body, with the two limits the previous version did not
 * have.
 *
 * Without a size cap, a request that never stops sending grows a string until
 * the process dies. Without a timeout, a request that sends one byte a minute
 * holds a socket and whatever it is queued behind. Both are trivial to send and
 * neither needs authentication to attempt, since the sign-in route reads a body
 * too.
 */

const { config } = require("../config.js");
const { ValidationError, AppError } = require("./errors.js");

class PayloadTooLargeError extends AppError {
  constructor(limit) {
    super(`Request body must be ${Math.floor(limit / 1024)} KB or smaller.`, {
      status: 413,
      code: "payload-too-large"
    });
  }
}

function readRaw(req, { limit = config.requestBodyLimitBytes, timeoutMs = config.requestBodyTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      fn(value);
    };

    const timer = setTimeout(() => {
      // Destroying the socket is the only way to stop a sender that is not
      // going to stop on its own.
      req.destroy();
      finish(reject, new AppError("Timed out reading the request body.", {
        status: 408, code: "body-timeout"
      }));
    }, timeoutMs);

    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(reject, new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks));
    const onError = (err) => finish(reject, err);
    const onAborted = () => finish(reject, new AppError("The request was aborted.", {
      status: 400, code: "aborted", expose: false
    }));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

/**
 * Reads and parses a JSON body. An empty body is an empty object, which is what
 * lets the several routes that take no body share one code path.
 */
async function readJson(req, options) {
  const raw = await readRaw(req, options);
  if (!raw.length) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new ValidationError(["The request body is not valid JSON."], { code: "bad-json" });
  }

  // A top-level array or string would make every `body.foo` below undefined and
  // produce a confusing validation error instead of an accurate one.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(["The request body must be a JSON object."], { code: "bad-json" });
  }
  return parsed;
}

module.exports = { readJson, readRaw, PayloadTooLargeError };
