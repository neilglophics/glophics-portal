/**
 * Sign-in rate limiting.
 *
 * Two independent counters, because they defend against two different things:
 *
 *   per username  -- someone guessing one person's password. A doubling backoff
 *                    that starts gently, so an honest typo costs nothing and a
 *                    tenth guess costs fifteen minutes.
 *
 *   per address   -- someone spraying one password across many accounts. Counted
 *                    as *distinct usernames failed*, never as raw failures:
 *                    everyone in an office shares one public address, so a raw
 *                    counter would let three colleagues mistyping their
 *                    passwords lock out the whole building. Nobody legitimately
 *                    fails against ten different usernames.
 *
 * Enforcement is an immediate rejection, never a delay. Sleeping on the request
 * holds a socket and a hashing slot, which turns a brute-force defence into a
 * self-inflicted denial of service.
 */

const { db } = require("../db/client.js");
const attempts = require("../repositories/auth-attempts.repo.js");
const { config } = require("../config.js");

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Failure count -> lockout. Starts at the third failure so an honest typo and
 * its retry are free, then doubles.
 */
const BACKOFF_MS = [0, 0, 0, 1_000, 2_000, 4_000, 8_000, 30_000, 60_000, 300_000];
const MAX_BACKOFF_MS = 900_000;

const PROFILES = {
  standard: { usernameThreshold: 3, sprayThreshold: 10, globalThreshold: null },
  // Used when the IP allowlist is open, i.e. when anything that can route to
  // the port can reach the sign-in form.
  strict: { usernameThreshold: 2, sprayThreshold: 5, globalThreshold: 200 }
};

const SPRAY_BLOCK_MS = 30 * 60 * 1000;
const GLOBAL_BLOCK_MS = 5 * 60 * 1000;

let isGateOpen = () => false;

/**
 * The IP allowlist decides which profile applies, and it is the outermost gate,
 * so this module is told about it rather than importing it -- keeping the
 * dependency pointing one way.
 */
function useGateStatus(fn) {
  isGateOpen = fn;
}

function profile() {
  if (config.throttleProfile === "strict") return { name: "strict", ...PROFILES.strict };
  if (config.throttleProfile === "standard") return { name: "standard", ...PROFILES.standard };
  return isGateOpen()
    ? { name: "strict (allowlist is open)", ...PROFILES.strict }
    : { name: "standard", ...PROFILES.standard };
}

function backoffFor(failures, threshold) {
  if (failures < threshold) return 0;
  // Re-base the curve on the profile's threshold so `strict` starts penalising
  // one failure earlier rather than using a different curve entirely.
  const index = failures + (PROFILES.standard.usernameThreshold - threshold);
  return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)] || MAX_BACKOFF_MS;
}

/**
 * How much of a block remains, given when the last offending attempt happened
 * and how long the block is meant to last.
 *
 * This is the piece that makes a lockout actually a *lock-out* rather than a
 * lock-forever: a raw "count >= threshold" check stays true for the rest of
 * the counting window regardless of how much time has passed since the last
 * failure, so without measuring elapsed time an account that crossed the
 * threshold once would stay blocked for the remainder of the window, unable
 * to ever produce the success that clears it.
 */
function remaining(lastFailedAt, blockMs) {
  if (!lastFailedAt) return 0;
  const elapsed = Date.now() - lastFailedAt.getTime();
  return Math.max(0, blockMs - elapsed);
}

/**
 * @returns {{allowed: true} | {allowed: false, retryAfterMs: number, reason: string}}
 */
async function check(username, clientIp) {
  const active = profile();

  if (active.globalThreshold !== null) {
    const global = await attempts.globalFailures(db, WINDOW_MS);
    if (global.count >= active.globalThreshold) {
      const left = remaining(global.lastFailedAt, GLOBAL_BLOCK_MS);
      if (left > 0) return { allowed: false, retryAfterMs: left, reason: "global" };
    }
  }

  const spray = await attempts.distinctUsernamesFailedFromIp(db, clientIp, WINDOW_MS);
  if (spray.count >= active.sprayThreshold) {
    const left = remaining(spray.lastFailedAt, SPRAY_BLOCK_MS);
    if (left > 0) {
      return { allowed: false, retryAfterMs: left, reason: "ip", distinctUsernames: spray.count };
    }
  }

  const failures = await attempts.failuresSinceLastSuccess(db, username, WINDOW_MS);
  const requiredBackoff = backoffFor(failures.count, active.usernameThreshold);
  if (requiredBackoff > 0) {
    const left = remaining(failures.lastFailedAt, requiredBackoff);
    if (left > 0) {
      return { allowed: false, retryAfterMs: left, reason: "username", failures: failures.count };
    }
  }

  return { allowed: true };
}

async function recordFailure(username, clientIp, outcome, userAgent) {
  await attempts.record(db, { username, ip: clientIp, outcome, userAgent });
}

/** Writes a success, which is what ends the username's backoff window. */
async function recordSuccess(username, clientIp, userAgent) {
  await attempts.record(db, { username, ip: clientIp, outcome: "success", userAgent });
}

async function unlock(username) {
  await attempts.forgive(db, username);
}

async function sweep(retentionDays = 90) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return attempts.deleteOlderThan(db, cutoff);
}

/** "3 minutes", for the message shown to whoever is locked out. */
function describeWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

module.exports = {
  check, recordFailure, recordSuccess, unlock, sweep,
  profile, useGateStatus, describeWait, WINDOW_MS
};
