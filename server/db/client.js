/**
 * The one place a database connection is created, and the only module
 * repositories are allowed to import.
 *
 * Two deliberate choices about the connection itself:
 *
 *   * `STRICT_ALL_TABLES` is forced per session. XAMPP ships MariaDB with a
 *     permissive sql_mode, under which an over-long string is silently
 *     truncated and a bad number becomes zero. Depending on server
 *     configuration for that would mean the same code corrupts data on one
 *     machine and not another.
 *
 *   * `timezone: "Z"` with `dateStrings` off. Everything is stored and read as
 *     UTC; the browser does the formatting. The previous implementation parsed
 *     Jira dates in server-local time, which is why a claim booked at 09:00
 *     meant something different depending on where the process happened to run.
 */

const mysql = require("mysql2/promise");
const { config } = require("../config.js");

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.database,
      waitForConnections: true,
      connectionLimit: config.databasePoolMax,
      maxIdle: config.databasePoolMax,
      idleTimeout: 60_000,
      connectTimeout: 15_000,
      charset: "utf8mb4_unicode_ci",
      timezone: "Z",
      supportBigNumbers: true,
      bigNumberStrings: false,
      // Migration files hold several statements each. This is enabled ONLY on
      // the dedicated migration connection (see runWithMultipleStatements) --
      // never on the pool that serves requests, where it would turn any
      // successful injection into a free second statement.
      multipleStatements: false
    });

    pool.on("connection", (connection) => {
      connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
      connection.query("SET SESSION time_zone = '+00:00'");
    });
  }
  return pool;
}

/** Runs one statement on a pooled connection. Returns the driver result. */
async function query(text, params) {
  const [rows, fields] = await getPool().execute(text, params ?? []);
  return { rows, fields };
}

async function many(text, params) {
  const [rows] = await getPool().execute(text, params ?? []);
  return rows;
}

async function one(text, params) {
  const rows = await many(text, params);
  if (rows.length > 1) {
    throw new Error(`Expected at most one row, got ${rows.length}: ${text.slice(0, 80)}`);
  }
  return rows[0] || null;
}

/** Rows affected / insertId, for writes. */
async function run(text, params) {
  const [result] = await getPool().execute(text, params ?? []);
  return result;
}

/**
 * A transaction handle exposes the same verbs as the module itself, so a
 * repository function can take the executor as its first argument and be
 * called either standalone or inside a transaction without changing.
 */
function wrap(connection) {
  return {
    isTransaction: true,
    query: async (text, params) => {
      const [rows, fields] = await connection.execute(text, params ?? []);
      return { rows, fields };
    },
    many: async (text, params) => {
      const [rows] = await connection.execute(text, params ?? []);
      return rows;
    },
    one: async (text, params) => {
      const [rows] = await connection.execute(text, params ?? []);
      if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
      return rows[0] || null;
    },
    run: async (text, params) => {
      const [result] = await connection.execute(text, params ?? []);
      return result;
    }
  };
}

// Deadlock and lock-wait timeout. Both mean "this transaction had no effect,
// try again" -- InnoDB rolls the whole transaction back, so a replay is safe.
const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

async function tx(fn, { attempt = 0 } = {}) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(wrap(connection));
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback().catch(() => {});
    if (RETRYABLE.has(err.code) && attempt === 0) {
      connection.release();
      return tx(fn, { attempt: 1 });
    }
    throw err;
  } finally {
    // Releasing twice is harmless; releasing zero times leaks the pool.
    connection.release();
  }
}

/**
 * A consistent read across several statements. InnoDB's default REPEATABLE
 * READ establishes the snapshot at the first read and holds it for the whole
 * transaction, so the eight SELECTs behind the board projection see one state
 * of the world rather than eight consecutive ones.
 */
async function snapshot(fn) {
  const connection = await getPool().getConnection();
  try {
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const result = await fn(wrap(connection));
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * A single connection with multi-statement support, for the migration runner
 * and nothing else. Callers get the raw mysql2 connection.
 */
async function withMultipleStatements(fn) {
  const connection = await mysql.createConnection({
    ...config.database,
    multipleStatements: true,
    charset: "utf8mb4_unicode_ci",
    timezone: "Z",
    connectTimeout: 15_000
  });
  try {
    await connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    await connection.query("SET SESSION time_zone = '+00:00'");
    return await fn(connection);
  } finally {
    await connection.end().catch(() => {});
  }
}

/** The default executor, so repositories can take `(db, ...)` uniformly. */
const db = { isTransaction: false, query, many, one, run };

async function close() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

async function ping() {
  await query("select 1");
}

module.exports = {
  db, query, many, one, run, tx, snapshot, close, ping, getPool, withMultipleStatements
};
