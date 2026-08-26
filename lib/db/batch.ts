/**
 * Writing many rows without paying for many round trips.
 *
 * ── Why this exists ──
 *
 * The Jira sync used to write one row per query: ~290 INSERTs into
 * `jira_issues`, plus one per claim and one per repo and per assignee, each an
 * `await` inside the transaction. On a full pass that is ~300 sequential round
 * trips, and it measured at ~20 SECONDS against ~1.5s for the Jira fetch
 * itself — enough to blow the 60s function budget on Vercel and answer
 * /api/jira/sync-now with a timeout, which is exactly what it did once every
 * status started being carried (ADR-014).
 *
 * Round trips are the whole cost; the rows themselves are tiny. One multi-row
 * statement per table took the same work from ~300 queries to about ten, and
 * the full pass from 21.6s to 3.0s. See docs/05-DECISIONS.md ADR-018.
 *
 * Nothing here interpolates a VALUE into SQL. What is built by concatenation is
 * the PLACEHOLDER list; every value is still bound as a parameter.
 */

/**
 * Rows per statement.
 *
 * Postgres binds at most 65535 parameters, so 200 rows of 13 columns (2600) is
 * comfortably clear of it while still being a single round trip for any
 * realistic pass — MAX_PAGES caps a sync at 500 issues.
 */
export const INSERT_CHUNK = 200;

export function* chunks<T>(rows: readonly T[], size: number = INSERT_CHUNK): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

/**
 * `($1, $2::text[], now()), ($3, $4::text[], now())` — the VALUES list for a
 * multi-row INSERT.
 *
 * `casts` is one entry per parameter column, `""` where the column type is
 * unambiguous from context. `literals` are per-row expressions with no
 * parameter of their own: `now()` for a column that has no DEFAULT.
 */
export function valuesList(
  rowCount: number,
  casts: readonly string[],
  literals: readonly string[] = [],
): string {
  const width = casts.length;
  return Array.from({ length: rowCount }, (_, row) => {
    const params = casts.map((cast, col) => `$${row * width + col + 1}${cast}`);
    return `(${[...params, ...literals].join(", ")})`;
  }).join(", ");
}

/**
 * The last row for each key, in first-seen order.
 *
 * `ON CONFLICT … DO UPDATE` is a hard ERROR if the same key appears twice in
 * ONE statement, where a row-at-a-time loop would simply have applied the
 * second write. A paged search can hand back a duplicate — an issue updated
 * mid-scan can appear on two pages of a `nextPageToken` cursor — so anything
 * upserted in a batch is de-duplicated first, keeping the LAST occurrence,
 * which is what writing them in order used to leave behind.
 *
 * `DO NOTHING` needs none of this: an in-statement duplicate is fine there.
 */
export function lastByKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}
