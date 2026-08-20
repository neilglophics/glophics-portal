/**
 * Password hashing.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 *   1. `crypto.scrypt`, not `scryptSync`. The synchronous form blocks the event
 *      loop for the whole process -- on a single-threaded server that also
 *      holds SSE streams open and polls Jira, one sign-in stalled everything.
 *
 *   2. Concurrency is bounded. The async form runs on the libuv threadpool,
 *      which has four threads by default and is shared with every fs and DNS
 *      call in the process. Left unbounded, four simultaneous sign-ins would
 *      starve static file serving. One thread is reserved for everyone else.
 *
 *   3. The stored hash carries its own parameters. That is what lets the cost
 *      be raised later: an old hash still verifies, and its owner is silently
 *      upgraded on their next sign-in rather than being locked out.
 */

const crypto = require("node:crypto");

// 128 * N * r = 32 MiB of memory per hash, roughly 100ms on a modern core.
//
// OWASP's floor for a public service is N = 2^17 (128 MiB). This is a single
// process that also serves the UI, and at 128 MiB across four threadpool slots
// a burst of sign-ins would allocate half a gigabyte and stall everything else.
// 2^15 is the largest value that leaves this box responsive under a burst, and
// is still several thousand times the cost of the unsalted-digest hashing this
// class of application usually ships with.
const CURRENT = { n: 32768, r: 8, p: 1, keylen: 32 };
const MAXMEM = 96 * 1024 * 1024; // must exceed 128 * n * r; Node's default 32MiB would throw

const ALGO = "scrypt";
const VERSION = 1;

// Reserve a thread so a burst of sign-ins cannot starve fs and DNS.
const THREADPOOL = Number(process.env.UV_THREADPOOL_SIZE) || 4;
const MAX_CONCURRENT = Math.max(1, THREADPOOL - 1);

let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.n, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

function b64(buffer) {
  return buffer.toString("base64url");
}

/**
 * Formats a hash and everything needed to reproduce it.
 *
 * `se` records how the salt should be interpreted. It is absent for hashes this
 * module produces (raw bytes) and is "utf8" for hashes imported from the old
 * JSON store, which passed a hex *string* to scrypt and therefore salted with
 * the 32 ASCII characters rather than the 16 bytes they spell. Recording it is
 * what stops a future refactor from "helpfully" hex-decoding the salt and
 * invalidating every password in one commit.
 */
function formatHash({ params, salt, hash, saltEncoding }) {
  const parts = [`n=${params.n}`, `r=${params.r}`, `p=${params.p}`];
  if (saltEncoding) parts.push(`se=${saltEncoding}`);
  return `$${ALGO}$v=${VERSION}$${parts.join(",")}$${b64(salt)}$${b64(hash)}`;
}

/** Throws on anything it does not fully understand. Callers treat a throw as
 *  "verification failed", never as "no password set". */
function parseHash(encoded) {
  if (typeof encoded !== "string") throw new Error("Password hash is not a string.");
  const fields = encoded.split("$");
  // ["", algo, "v=1", "n=...,r=...,p=...", salt, hash]
  if (fields.length !== 6 || fields[0] !== "") throw new Error("Malformed password hash.");
  const [, algo, versionField, paramField, saltField, hashField] = fields;
  if (algo !== ALGO) throw new Error(`Unsupported password algorithm "${algo}".`);

  const version = Number((versionField.match(/^v=(\d+)$/) || [])[1]);
  if (!Number.isInteger(version)) throw new Error("Malformed password hash version.");

  const params = {};
  let saltEncoding = null;
  for (const pair of paramField.split(",")) {
    const [key, value] = pair.split("=");
    if (key === "se") saltEncoding = value;
    else params[key] = Number(value);
  }
  if (!params.n || !params.r || !params.p) throw new Error("Malformed password hash parameters.");

  const salt = Buffer.from(saltField, "base64url");
  const hash = Buffer.from(hashField, "base64url");
  if (!salt.length || !hash.length) throw new Error("Malformed password hash payload.");

  return { algo, version, params: { ...params, keylen: hash.length }, salt, hash, saltEncoding };
}

/**
 * Unicode-normalises before hashing so the same password typed through an IME
 * and through a plain keyboard produce the same bytes. Deliberately does NOT
 * trim: trimming silently turns a password into something other than what was
 * typed, and the user has no way to discover that.
 */
function normalize(password) {
  return String(password).normalize("NFKC");
}

async function hash(password) {
  const salt = crypto.randomBytes(16);
  await acquire();
  try {
    const derived = await scrypt(normalize(password), salt, CURRENT);
    return formatHash({ params: CURRENT, salt, hash: derived, saltEncoding: null });
  } finally {
    release();
  }
}

/**
 * Verifies a password, and reports whether the stored hash was made with
 * parameters this module no longer uses.
 *
 * Returns `{ ok, needsRehash }` rather than throwing, so a malformed stored
 * hash is a failed sign-in rather than a 500 -- but it never returns `ok: true`
 * for one.
 */
async function verify(password, encoded) {
  let parsed;
  try {
    parsed = parseHash(encoded);
  } catch (err) {
    return { ok: false, needsRehash: false };
  }

  const salt = parsed.saltEncoding === "utf8" ? parsed.salt.toString("latin1") : parsed.salt;

  await acquire();
  let derived;
  try {
    derived = await scrypt(normalize(password), salt, parsed.params);
  } catch (err) {
    return { ok: false, needsRehash: false };
  } finally {
    release();
  }

  if (derived.length !== parsed.hash.length) return { ok: false, needsRehash: false };
  const ok = crypto.timingSafeEqual(derived, parsed.hash);

  const stale =
    parsed.version !== VERSION ||
    parsed.saltEncoding !== null ||
    parsed.params.n !== CURRENT.n ||
    parsed.params.r !== CURRENT.r ||
    parsed.params.p !== CURRENT.p ||
    parsed.params.keylen !== CURRENT.keylen;

  return { ok, needsRehash: ok && stale };
}

/**
 * Converts a record from the old `config/auth.json` into a stored hash string,
 * without recomputing anything -- the password is not available at import time.
 *
 * The old code did `salt = randomBytes(16).toString("hex")` and passed that
 * *string* to scryptSync, so the salt material is the 32 ASCII bytes of the hex
 * text. `se=utf8` records exactly that.
 */
function encodeLegacy({ salt, hash: hexHash }) {
  return formatHash({
    params: { n: 16384, r: 8, p: 1, keylen: Buffer.from(hexHash, "hex").length },
    salt: Buffer.from(salt, "latin1"),
    hash: Buffer.from(hexHash, "hex"),
    saltEncoding: "utf8"
  });
}

/**
 * A real hash over a value nobody knows, computed once at startup.
 *
 * Sign-in always runs exactly one verification -- against this when the account
 * does not exist. Without it, a missing username answers in microseconds while
 * a real one costs a full scrypt, and the deliberately identical error message
 * is defeated by a stopwatch.
 */
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hash(crypto.randomBytes(32).toString("base64url"));
  return dummyHashPromise;
}

/** Burns one verification's worth of time, for the no-such-user path. */
async function burn(password) {
  await verify(password, await dummyHash());
}

module.exports = {
  hash, verify, parseHash, formatHash, encodeLegacy, burn, normalize,
  CURRENT_PARAMS: CURRENT
};
