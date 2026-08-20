/**
 * Forward-only migration runner.  npm run db:migrate
 *
 * Applies every unapplied file in lib/db/migrations, in filename order, each in
 * its own transaction. Records what it applied in `schema_migrations` so a
 * re-run is a no-op.
 *
 * Runs against DATABASE_URL_UNPOOLED — the direct Neon string. DDL through a
 * connection pooler in transaction mode can land on different backends between
 * statements, which is exactly what you do not want while altering tables.
 *
 * There is no `down`. A mistake is corrected by a new migration, never by
 * editing an applied one: the applied file is the only record of what production
 * actually ran.
 */

import fs from "node:fs";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";
import { loadEnv, requireEnv } from "./_env";

loadEnv();

const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

async function main() {
  const connectionString = requireEnv(
    "DATABASE_URL_UNPOOLED",
    "Use the DIRECT (non-pooler) Neon connection string for migrations.",
  );

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`No migrations directory at ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    console.log("No migration files found.");
    return;
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const pending = files.filter((f) => !applied.has(f));
    if (!pending.length) {
      console.log(`Up to date — ${applied.size} migration(s) already applied.`);
      return;
    }

    for (const name of pending) {
      const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      process.stdout.write(`  applying ${name} … `);

      try {
        await client.query("BEGIN");
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        // Say which file and stop. Continuing would apply later migrations on
        // top of a schema that is not what they were written against.
        throw new Error(`${name} failed: ${(err as Error).message}`);
      }
    }

    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`\nMigration failed: ${err.message}`);
  process.exit(1);
});
