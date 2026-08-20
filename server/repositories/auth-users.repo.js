/**
 * Login accounts.
 *
 * Two shapes leave this file and they are not interchangeable:
 *
 *   toPublicUser(row)   what /api/auth/* returns. No hash, ever.
 *   the raw row          only auth.service sees this, only to verify a password.
 *
 * `toPublicUser` names the fields it emits rather than deleting the ones it
 * must not. A delete-list quietly starts leaking the day somebody adds a column;
 * an allowlist quietly starts omitting one, which is the failure you want.
 */

const { bool, isoOrNull } = require("../db/columns.js");

const COLUMNS = `
  id, username, display_name, role, directory_user_id, password_hash,
  password_changed_at, must_change_password, active, created_at, updated_at, last_login_at
`;

/**
 * The account as the browser may see it.
 *
 * `jiraNames` is not a column -- it belongs to the directory person this login
 * speaks for, and is filled in by the service, which is the only layer allowed
 * to reach across into the directory.
 */
function toPublicUser(row, jiraNames = []) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    directoryUserId: row.directory_user_id,
    jiraNames,
    active: bool(row.active),
    mustChangePassword: bool(row.must_change_password),
    createdAt: isoOrNull(row.created_at),
    lastLoginAt: isoOrNull(row.last_login_at)
  };
}

async function list(db) {
  return db.many(`select ${COLUMNS} from auth_users order by lower(username)`);
}

async function findById(db, id) {
  return db.one(`select ${COLUMNS} from auth_users where id = ?`, [id]);
}

/** Case-insensitive, so "Admin" and "admin" are the same account. */
async function findByUsername(db, username) {
  return db.one(`select ${COLUMNS} from auth_users where username_key = lower(trim(?))`, [username]);
}

async function findByDirectoryUserId(db, directoryUserId) {
  if (!directoryUserId) return null;
  return db.one(`select ${COLUMNS} from auth_users where directory_user_id = ?`, [directoryUserId]);
}

async function countAll(db) {
  const row = await db.one("select count(*) as total from auth_users");
  return Number(row.total);
}

/**
 * How many active accounts hold a given role. The service uses this to refuse
 * to remove the last super admin -- a lockout with no way back in.
 */
async function countActiveWithRole(db, role, exceptId = null) {
  const params = [role];
  let sql = "select count(*) as total from auth_users where role = ? and active = 1";
  if (exceptId) { sql += " and id <> ?"; params.push(exceptId); }
  const row = await db.one(sql, params);
  return Number(row.total);
}

async function insert(db, user) {
  await db.run(
    `insert into auth_users
       (id, username, display_name, role, directory_user_id, password_hash,
        password_changed_at, must_change_password, active)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id, user.username, user.displayName, user.role,
      user.directoryUserId ?? null, user.passwordHash,
      user.passwordChangedAt ?? null,
      user.mustChangePassword ? 1 : 0,
      user.active === false ? 0 : 1
    ]
  );
}

async function update(db, id, patch) {
  const sets = ["updated_at = current_timestamp(3)"];
  const params = [];
  const assign = (column, value) => { sets.push(`${column} = ?`); params.push(value); };

  if (patch.username !== undefined) assign("username", patch.username);
  if (patch.displayName !== undefined) assign("display_name", patch.displayName);
  if (patch.role !== undefined) assign("role", patch.role);
  if (patch.directoryUserId !== undefined) assign("directory_user_id", patch.directoryUserId);
  if (patch.active !== undefined) assign("active", patch.active ? 1 : 0);
  if (patch.mustChangePassword !== undefined) {
    assign("must_change_password", patch.mustChangePassword ? 1 : 0);
  }
  if (patch.lastLoginAt !== undefined) assign("last_login_at", patch.lastLoginAt);

  params.push(id);
  await db.run(`update auth_users set ${sets.join(", ")} where id = ?`, params);
}

/**
 * Writes a new hash and stamps when it happened, clearing the
 * force-change flag in the same statement so the two can never disagree.
 */
async function setPassword(db, id, passwordHash, { mustChangePassword = false } = {}) {
  await db.run(
    `update auth_users
        set password_hash = ?, password_changed_at = current_timestamp(3),
            must_change_password = ?, updated_at = current_timestamp(3)
      where id = ?`,
    [passwordHash, mustChangePassword ? 1 : 0, id]
  );
}

/**
 * Replaces the hash without touching password_changed_at or the force-change
 * flag. Used only by the transparent rehash on sign-in: the password did not
 * change, only the cost it is stored at.
 */
async function replaceHash(db, id, passwordHash) {
  await db.run("update auth_users set password_hash = ? where id = ?", [passwordHash, id]);
}

async function remove(db, id) {
  const result = await db.run("delete from auth_users where id = ?", [id]);
  return result.affectedRows > 0;
}

/** Distinct roles in use, so boot can check them against AUTH_ROLES. */
async function distinctRoles(db) {
  const rows = await db.many("select distinct role from auth_users");
  return rows.map((row) => row.role);
}

module.exports = {
  toPublicUser, list, findById, findByUsername, findByDirectoryUserId,
  countAll, countActiveWithRole, insert, update, setPassword, replaceHash,
  remove, distinctRoles
};
