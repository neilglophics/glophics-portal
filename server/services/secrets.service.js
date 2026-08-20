/**
 * Encrypted third-party credentials.
 *
 * Today, this is exactly one secret: the Jira API token. It moves here rather
 * than staying in config/jira-config.json for one reason -- that file was
 * written with fs.writeFileSync and no mode, so it landed at the process
 * umask (typically 0644) with a live API token readable by anyone with a
 * shell on the box. auth.json got 0600; this file never did.
 *
 * AES-256-GCM under APP_SECRET_KEY. The secret's name is the additional
 * authenticated data, so a ciphertext cannot be lifted from one row and
 * replayed into another with a different name.
 */

const crypto = require("node:crypto");
const { db } = require("../db/client.js");
const secretsRepo = require("../repositories/secrets.repo.js");
const { config } = require("../config.js");
const { UnavailableError } = require("../http/errors.js");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

function requireKey() {
  if (!config.secretKey) {
    throw new UnavailableError(
      "This deployment has secrets stored but no APP_SECRET_KEY configured. " +
      "Set it before anything that reads a secret can run.",
      { code: "secret-key-missing" }
    );
  }
  return config.secretKey;
}

function encrypt(name, plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decrypt(name, row, key) {
  const decipher = crypto.createDecipheriv(ALGO, key, row.iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
}

async function get(name) {
  const row = await secretsRepo.get(db, name);
  if (!row) return null;
  const key = row.key_version === 2 && config.previousSecretKey ? config.previousSecretKey : requireKey();
  try {
    return decrypt(name, row, key);
  } catch (err) {
    // A wrong key produces an authentication failure, not a wrong plaintext --
    // GCM guarantees that. Surfacing it plainly is what stops this from being
    // mistaken for "Jira is just disconnected" days later.
    throw new UnavailableError(
      `Could not decrypt "${name}". APP_SECRET_KEY may not match the key it was stored with.`,
      { code: "secret-decrypt-failed" }
    );
  }
}

async function put(name, plaintext, actorId = null) {
  const key = requireKey();
  const { ciphertext, iv, authTag } = encrypt(name, plaintext, key);
  await secretsRepo.put(db, name, { ciphertext, iv, authTag, keyVersion: 1, updatedBy: actorId });
}

async function remove(name) {
  return secretsRepo.remove(db, name);
}

/** Re-encrypts every stored secret under the current key. For key rotation. */
async function reencryptAll(actorId = null) {
  const key = requireKey();
  const previous = config.previousSecretKey;
  let count = 0;
  for (const row of await secretsRepo.listAll(db)) {
    const sourceKey = row.key_version === 2 && previous ? previous : key;
    const plaintext = decrypt(row.name, row, sourceKey);
    const { ciphertext, iv, authTag } = encrypt(row.name, plaintext, key);
    await secretsRepo.put(db, row.name, { ciphertext, iv, authTag, keyVersion: 1, updatedBy: actorId });
    count += 1;
  }
  return { count };
}

module.exports = { get, put, remove, reencryptAll };
