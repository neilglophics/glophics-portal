/**
 * Migrations: numbered SQL files, applied once, in order.
 *
 * Three properties matter more than features here:
 *   - a failed migration must stop the boot, not leave a half-built schema;
 *   - two instances starting at once must not both apply 007;
 *   - an already-applied file that someone later edited must be caught, because
 *     the schema in the database no longer matches the file that claims to
 *     describe it. That is the failure that costs a weekend.
 *
 * MySQL and MariaDB give DDL no transactional protection: `create table` commits
 * implicitly, so a file that fails halfway leaves the earlier statements in
 * place. There is no way around that short of an external schema differ, so the
 * runner does the next best thing -- it records nothing for a failed file and
 * refuses to continue, leaving the operator with one named file to inspect
 * rather than a partially migrated database of unknown shape.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { withMultipleStatements } = require("./client.js");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const FILENAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
const LOCK_NAME = "server_management_migrations";
const LOCK_TIMEOUT_SECONDS = 30;

function readMigrations() {
  const entries = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  const bad = entries.filter((name) => !FILENAME_PATTERN.test(name));
  if (bad.length) {
    throw new Error(
      `Migration filenames must look like 001_name.sql -- these do not: ${bad.join(", ")}`
    );
  }
  return entries.sort().map((name) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
    return {
      version: name.slice(0, 3),
      name,
      sql,
      checksum: crypto.createHash("sha256").update(sql).digest("hex")
    };
  });
}

async function ensureLedger(connection) {
  await connection.query(`
    create table if not exists schema_migrations (
      version     varchar(8)   not null primary key,
      name        varchar(255) not null,
      checksum    char(64)     not null,
      applied_at  datetime(3)  not null default current_timestamp(3),
      duration_ms int          null
    ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci
  `);
}

async function acquireLock(connection) {
  const [rows] = await connection.query("select get_lock(?, ?) as acquired", [
    LOCK_NAME,
    LOCK_TIMEOUT_SECONDS
  ]);
  if (rows[0].acquired !== 1) {
    throw new Error(
      `Could not acquire the migration lock within ${LOCK_TIMEOUT_SECONDS}s. ` +
      "Another instance is probably migrating right now."
    );
  }
}

/**
 * Applies every pending migration. Returns the names it applied, so the caller
 * can say something useful on a first boot and nothing at all on the hundredth.
 */
async function run({ log = console.log } = {}) {
  const migrations = readMigrations();

  return withMultipleStatements(async (connection) => {
    const applied = [];
    await acquireLock(connection);
    try {
      await ensureLedger(connection);

      const [rows] = await connection.query("select version, checksum, name from schema_migrations");
      const ledger = new Map(rows.map((r) => [r.version, r]));

      for (const migration of migrations) {
        const record = ledger.get(migration.version);

        if (record) {
          if (record.checksum !== migration.checksum) {
            throw new Error(
              `Migration ${migration.name} has changed since it was applied.\n` +
              "Migrations are immutable once they have run. Add a new numbered file instead."
            );
          }
          continue;
        }

        const startedAt = Date.now();
        try {
          await connection.query(migration.sql);
        } catch (err) {
          throw new Error(
            `Migration ${migration.name} failed: ${err.message}\n` +
            "DDL is not transactional here, so statements before the failure have " +
            "already been applied. Inspect the schema before retrying."
          );
        }

        const durationMs = Date.now() - startedAt;
        await connection.query(
          "insert into schema_migrations (version, name, checksum, duration_ms) values (?, ?, ?, ?)",
          [migration.version, migration.name, migration.checksum, durationMs]
        );

        applied.push(migration.name);
        log(`[migrate] applied ${migration.name} (${durationMs}ms)`);
      }

      return applied;
    } finally {
      await connection.query("select release_lock(?)", [LOCK_NAME]).catch(() => {});
    }
  });
}

/** Read-only: what is applied, what is pending, what has drifted. */
async function status() {
  const migrations = readMigrations();
  return withMultipleStatements(async (connection) => {
    await ensureLedger(connection);
    const [rows] = await connection.query("select version, checksum, applied_at from schema_migrations");
    const ledger = new Map(rows.map((r) => [r.version, r]));
    return migrations.map((migration) => {
      const record = ledger.get(migration.version);
      if (!record) return { version: migration.version, name: migration.name, state: "pending", appliedAt: null };
      if (record.checksum !== migration.checksum) {
        return { version: migration.version, name: migration.name, state: "drifted", appliedAt: record.applied_at };
      }
      return { version: migration.version, name: migration.name, state: "applied", appliedAt: record.applied_at };
    });
  });
}

module.exports = { run, status, MIGRATIONS_DIR };
