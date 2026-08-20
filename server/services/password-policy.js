/**
 * What counts as an acceptable password.
 *
 * Enforced in exactly one place -- this function -- and called by every path
 * that sets a password: self-service change, admin reset, account creation, and
 * first-run seeding. A rule that lives in a route is a rule the CLI does not
 * have.
 *
 * The minimum length is 8 rather than the 12 a fresh design would pick. The
 * sign-in form tells the user "At least 8 characters", and this rewrite is
 * explicitly not touching the interface; enforcing a longer password than the
 * form advertises would be a worse bug than the weaker rule. PASSWORD_MIN_LENGTH
 * raises it for a deployment that updates the copy to match.
 */

const MIN_LENGTH = (() => {
  const raw = Number(process.env.PASSWORD_MIN_LENGTH);
  return Number.isInteger(raw) && raw >= 8 && raw <= 128 ? raw : 8;
})();

// A hard ceiling, not a security rule: hashing is deliberately expensive, so an
// unbounded password is an unbounded amount of CPU per request.
const MAX_LENGTH = 256;

/**
 * The passwords that actually appear at the top of every breach corpus, plus
 * the ones this application invites by name. Not a substitute for a real
 * breached-password service -- it is the 40 lines that stop the worst choices
 * without adding a dependency or a network call to the sign-in path.
 */
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234",
  "passw0rd", "p@ssword", "p@ssw0rd", "letmein", "welcome", "welcome1",
  "qwerty", "qwerty123", "qwertyuiop", "asdfghjkl", "zxcvbnm",
  "12345678", "123456789", "1234567890", "123123123", "11111111",
  "abc12345", "a1b2c3d4", "iloveyou", "sunshine", "princess", "football",
  "baseball", "superman", "batman123", "trustno1", "dragon123", "monkey123",
  "master123", "shadow123", "michael1", "jennifer", "starwars", "computer",
  "changeme", "changeme1", "default1", "temp1234", "test1234", "admin123",
  "administrator", "root1234", "server123", "manager1", "secret12",
  "admin1234", "servermanagement", "server-management"
]);

function check(password, { username = "", displayName = "", boardName = "" } = {}) {
  const errors = [];

  if (typeof password !== "string" || password.length === 0) {
    return ["Enter a password."];
  }

  // Normalise the same way the hasher will, so the length that is checked is
  // the length that gets hashed.
  const value = password.normalize("NFKC");

  if (value.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  if (value.length > MAX_LENGTH) {
    errors.push(`Password must be ${MAX_LENGTH} characters or fewer.`);
  }

  const lower = value.toLowerCase();

  if (COMMON.has(lower)) {
    errors.push("That password is too common. Pick something less guessable.");
  }

  for (const [label, other] of [
    ["username", username],
    ["display name", displayName],
    ["name", boardName]
  ]) {
    const candidate = String(other || "").trim().toLowerCase();
    if (candidate && candidate.length >= 3 && lower === candidate) {
      errors.push(`Password must not be the same as your ${label}.`);
    }
  }

  if (value.length >= MIN_LENGTH && new Set(value).size === 1) {
    errors.push("Password must not be the same character repeated.");
  }

  return errors;
}

module.exports = { check, MIN_LENGTH, MAX_LENGTH };
