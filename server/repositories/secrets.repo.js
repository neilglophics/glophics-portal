/**
 * Encrypted third-party credentials.
 *
 * Storage only -- this file never sees a plaintext value and holds no key. The
 * encryption lives one layer up, in services/secrets.service.js, so that
 * "where is the Jira token decrypted?" has exactly one answer.
 */

async function get(db, name) {
  return db.one(
    "select name, ciphertext, iv, auth_tag, key_version from secrets where name = ?",
    [name]
  );
}

async function put(db, name, { ciphertext, iv, authTag, keyVersion, updatedBy = null }) {
  await db.run(
    `insert into secrets (name, ciphertext, iv, auth_tag, key_version, updated_by)
     values (?, ?, ?, ?, ?, ?)
     on duplicate key update
       ciphertext = values(ciphertext), iv = values(iv), auth_tag = values(auth_tag),
       key_version = values(key_version), updated_by = values(updated_by),
       updated_at = current_timestamp(3)`,
    [name, ciphertext, iv, authTag, keyVersion, updatedBy]
  );
}

async function remove(db, name) {
  const result = await db.run("delete from secrets where name = ?", [name]);
  return result.affectedRows > 0;
}

async function listNames(db) {
  const rows = await db.many("select name from secrets order by name");
  return rows.map((row) => row.name);
}

async function listAll(db) {
  return db.many("select name, ciphertext, iv, auth_tag, key_version from secrets order by name");
}

async function count(db) {
  const row = await db.one("select count(*) as total from secrets");
  return Number(row.total);
}

module.exports = { get, put, remove, listNames, listAll, count };
