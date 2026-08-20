/**
 * Neon access. Two modes, and picking the wrong one per call site is the classic
 * serverless mistake — so each export says which it is for.
 *
 *   sql`…`            HTTP, one round trip, no connection setup. THE DEFAULT.
 *   withTransaction() pooled WebSocket. Only when statements must be atomic.
 *
 * Never open an unpooled TCP pool from a function: invocations scale out
 * independently and would exhaust Postgres connections. DATABASE_URL must be the
 * *pooled* Neon string (`…-pooler.<region>.aws.neon.tech`); the direct one is
 * DATABASE_URL_UNPOOLED and is for migrations only.
 *
 * Local development uses a Neon branch, not a local Postgres — the HTTP driver
 * speaks Neon's protocol, not plain wire protocol.
 */

import { neon, Pool, type PoolClient } from "@neondatabase/serverless";

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at your Neon branch " +
        "(use the POOLED connection string).",
    );
  }
  return url;
}

/**
 * One-shot queries.
 *
 *   const rows = await sql`SELECT id FROM servers WHERE account_id = ${id}`;
 *
 * Interpolations are parameterised, not concatenated. Never build a query by
 * string addition; if a query needs a dynamic identifier, whitelist it.
 *
 * Created lazily and then cached. The HTTP driver is stateless `fetch` under the
 * hood so a cached instance is safe across invocations — but constructing it
 * eagerly at module scope would throw during `next build`, which imports this
 * module without a database being reachable.
 */
type Sql = ReturnType<typeof neon>;
let cached: Sql | null = null;

function client(): Sql {
  if (!cached) cached = neon(connectionString());
  return cached;
}

export const sql: Sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client() as any)(strings, ...values)) as unknown as Sql;

/**
 * An interactive transaction, for the writes that must not half-apply.
 *
 * Sending a chat message is the canonical case: insert the message, bump
 * `last_message_at`, advance the sender's read watermark — one unit, or none of
 * it. Publishing to Pusher happens **after** this resolves, never inside the
 * callback: if the transaction rolled back after Pusher had been told, every
 * client would render a message the database does not have.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: connectionString() });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already gone; the transaction dies with it either way.
    }
    throw err;
  } finally {
    client.release();
    // A pool created per invocation must be closed, or the function can be held
    // alive by an idle socket after the response has been sent.
    await pool.end();
  }
}

/** True when a Postgres error is a unique-constraint violation, so callers can
 *  treat "already exists" as a normal outcome rather than a failure. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
