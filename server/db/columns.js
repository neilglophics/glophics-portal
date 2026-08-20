/**
 * Column conversions that every repository needs.
 *
 * MariaDB's JSON type is LONGTEXT with a validity constraint, so the driver
 * hands back a string where MySQL 8 would hand back a parsed value. Rather than
 * scatter JSON.parse through the repositories -- and have the code quietly
 * break the day someone points it at MySQL 8, where the value is already an
 * object -- every read goes through these two functions.
 */

/** JSON column -> JS array. Tolerates both the string and already-parsed forms. */
function jsonArray(value, fallback = []) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
      return fallback;
    }
  }
  return fallback;
}

/** JSON column -> plain object. */
function jsonObject(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
      return fallback;
    }
  }
  return fallback;
}

/** JS value -> JSON column parameter. */
function toJson(value) {
  return JSON.stringify(value ?? null);
}

/**
 * datetime(3) -> the ISO string the browser has always received.
 *
 * The driver returns a Date built from a UTC-pinned session, so this is only a
 * formatting step -- but it is the one place the wire format is decided, and
 * every claim, sync timestamp and audit entry passes through it.
 */
function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * An incoming ISO string -> a Date the driver can bind, or null.
 *
 * Returns null for anything unparseable rather than an Invalid Date, which
 * MySQL would reject with a message about the driver instead of about the input.
 */
function toDate(value) {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** tinyint(1) -> boolean. */
function bool(value) {
  return value === 1 || value === true || value === "1";
}

module.exports = { jsonArray, jsonObject, toJson, isoOrNull, toDate, bool };
