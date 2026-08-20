/**
 * What happens once, at startup: seeding the first login when none exist, and
 * checking that every stored role is one this build understands.
 */

const crypto = require("node:crypto");
const { db, tx } = require("../db/client.js");
const authUsers = require("../repositories/auth-users.repo.js");
const passwords = require("../security/passwords.js");
const policy = require("../services/password-policy.js");
const audit = require("./audit.service.js");
const { config } = require("../config.js");
const { AUTH_ROLES, isValidRole } = require("../../shared/data.js");

const SEED_LOCK_NAME = "server_management_seed";

/**
 * Creates the first super admin, if and only if no login exists yet.
 *
 * In production, ADMIN_PASSWORD is required -- there is no hardcoded fallback,
 * unlike the previous "admin" / "admin1234" pair, which was published in this
 * repository's own README. Outside production, a random password is generated
 * and printed once, so a fresh clone still runs with one command.
 */
async function seedIfEmpty() {
  const connection = await require("../db/client.js").getPool().getConnection();
  try {
    const [locked] = await connection.query("select get_lock(?, 30) as ok", [SEED_LOCK_NAME]);
    if (locked[0].ok !== 1) {
      throw new Error("Could not acquire the seed lock; another instance may be starting concurrently.");
    }

    const existing = await authUsers.countAll(db);
    if (existing > 0) return null;

    const username = authAdminNormalize(config.adminUsername || "admin");
    let password;
    let source;

    if (config.adminPassword) {
      const errors = policy.check(config.adminPassword, { username });
      if (errors.length) {
        throw new Error(`ADMIN_PASSWORD does not meet the password policy:\n  - ${errors.join("\n  - ")}`);
      }
      password = config.adminPassword;
      source = "env";
    } else if (config.isProduction) {
      throw new Error(
        "No sign-in accounts exist and ADMIN_PASSWORD is not set.\n" +
        "Set ADMIN_USERNAME/ADMIN_PASSWORD, or run:\n" +
        "    node scripts/admin.js create-admin <username>"
      );
    } else {
      password = crypto.randomBytes(18).toString("base64url");
      source = "generated";
    }

    const hash = await passwords.hash(password);
    const id = crypto.randomUUID();

    await tx(async (t) => {
      await authUsers.insert(t, {
        id, username, displayName: "Super Admin", role: "superadmin",
        passwordHash: hash, passwordChangedAt: null,
        mustChangePassword: true, active: true
      });
      await audit.record(t, audit.EVENTS.ADMIN_SEEDED, null, {
        target: { type: "user", id, label: username },
        detail: { role: "superadmin" }
      });
    });

    return { username, password, source };
  } finally {
    await connection.query("select release_lock(?)", [SEED_LOCK_NAME]).catch(() => {});
    connection.release();
  }
}

function authAdminNormalize(username) {
  return String(username || "").trim().toLowerCase();
}

/**
 * shared/data.js's AUTH_ROLES is the single source of truth for what a role
 * means; there is deliberately no CHECK constraint on auth_users.role that
 * would duplicate it. This is the substitute: on boot, every distinct role
 * actually stored is checked against it, and anything unrecognised is logged
 * loudly. roleCan() already fails such a role closed -- it grants nothing --
 * so this is a diagnostic, not a gate.
 */
async function assertRolesValid() {
  const roles = await authUsers.distinctRoles(db);
  const unknown = roles.filter((role) => !isValidRole(role));
  if (unknown.length) {
    console.error(
      `[bootstrap] ${unknown.length} account(s) carry a role not in AUTH_ROLES: ` +
      `${unknown.join(", ")}. They will be treated as having no permissions at all ` +
      "until their role is corrected."
    );
  }
  return { knownRoles: AUTH_ROLES.map((r) => r.id), unknownRoles: unknown };
}

module.exports = { seedIfEmpty, assertRolesValid };
