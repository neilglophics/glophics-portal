/**
 * Does the paged query return the same tickets the unpaged code did?
 * npm run verify:tickets
 *
 * The ticket tables used to read the whole board and slice it in JavaScript.
 * They now ask Postgres for one page. That moved two subtle things across the
 * boundary, and this script exists to check both against the real database
 * rather than against a fixture that agrees with whatever was written:
 *
 *   1. THE ORDERING AND THE SLICING. Walking every page must reproduce the old
 *      full list exactly — same rows, same order, no row seen twice, none
 *      missed. Most rows have no end_time, so they all tie on the sort key; if
 *      the ORDER BY were not a total order this is where it would show, as a
 *      duplicate on one page and a hole on the next.
 *
 *   2. THE `mine` PREDICATE. lib/db/queries/tickets.ts reimplements
 *      claimIsMine() in SQL, because the filter has to sit next to LIMIT for the
 *      count and the page to agree. That is the same rule written twice, so it
 *      is checked ticket by ticket, for every account that can sign in — and for
 *      an empty identity set, which must match nothing rather than everything.
 *
 *   3. THE STATUS CHIPS. The counts behind them come from a GROUP BY, and the
 *      rows they claim to count come from a WHERE — two different expressions
 *      that have to file every row the same way, and both have to agree with
 *      statusKey() in JS. A chip reading 13 above a pager reading 12 is the
 *      failure this catches, and it is checked for the whole board and again
 *      for each signed-in person's own list.
 *
 *   4. THE HIDE LIST. `ignoredStatuses` used to be a `status NOT IN (…)` clause
 *      in the sync's JQL; it is now a `hideStatuses` argument to this query, and
 *      Active tickets is the only reader that passes it (ADR-014). So it is
 *      checked the same way: the rows it removes must be exactly the rows at
 *      those statuses, and no chip may offer a cut it would then refuse.
 *
 * Read-only: it takes no locks and writes nothing.
 */

import { loadEnv, requireEnv } from "./_env";

loadEnv();
requireEnv("DATABASE_URL");

const { getBoard, getJiraIssues } = await import("@/lib/db/queries/board");
const { getTicketPage, statusKey } = await import("@/lib/db/queries/tickets");
const { listAuthUsers } = await import("@/lib/db/queries/auth");
const { getSettings } = await import("@/lib/db/queries/board");
const { claimIsMine, identityValues } = await import("@/lib/shared/mine");
const { TICKETS_PER_PAGE } = await import("@/lib/shared/pagination");
const { boardRows, claimRows } = await import("@/lib/shared/view-model");

type TicketRow = Awaited<ReturnType<typeof claimRows>>[number];

let passed = 0;
const failures: string[] = [];

function check(what: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${what} — ${detail}` : what);
}

const { accounts, environments, claims, directory } = await getBoard();
const issues = await getJiraIssues();

console.log(
  `board: ${claims.length} claims, ${issues.length} cached issues, ` +
    `${directory.length} people, ${TICKETS_PER_PAGE} rows a page\n`,
);

/** The row identity the tables key on, so two lists can be compared as text. */
const keysOf = (rows: { claim: { id: string }; holding: boolean }[]): string[] =>
  rows.map((r) => `${r.holding ? "claim" : "issue"}:${r.claim.id}`);

/**
 * The value each row is ORDERED BY: its end time, with "no end time" sorting
 * last. Compared instead of the row id wherever ORDER is being checked.
 *
 * Row identity is the wrong thing to compare there, because the unpaged order
 * was never fully determined. `getClaims()` orders by `claimed_at DESC` alone,
 * and every claim written by one sync pass carries the SAME claimed_at to the
 * millisecond — so two of them tied on the only sort column and Postgres
 * returned them in whatever order it liked. The paged query adds `id` as a final
 * tiebreak to make the order total, which is what OFFSET needs: without it the
 * two rows could swap between the request for page 1 and the request for page 2,
 * showing one twice and losing the other.
 *
 * So the check below is the honest one: the two orders must agree position for
 * position on the SORT KEY. Rows that tie on it may legitimately swap.
 */
const sortKeys = (rows: { claim: { endTime?: string | null } }[]): string[] =>
  // Normalised to an ISO string, which sorts lexicographically the way the
  // timestamp sorts. NOT compared raw: the driver hands timestamptz back as a
  // Date object, so `===` on two equal instants is false and every comparison
  // here would silently "differ".  "~" outranks every digit, so a row with no
  // end time sorts last, which is what NULLS LAST means.
  rows.map((r) => (r.claim.endTime ? new Date(r.claim.endTime).toISOString() : "~none"));

/** Walk every page of a query and return the keys in the order they appeared. */
async function walk(
  mine: string[] | null,
  status: string | null = null,
  hideStatuses: string[] | null = null,
): Promise<{ keys: string[]; rows: TicketRow[]; totals: string }> {
  const first = await getTicketPage({ page: 1, mine, status, hideStatuses });
  const keys: string[] = [];
  const all: TicketRow[] = [];

  for (let p = 1; p <= first.position.pageCount; p += 1) {
    const page = p === 1 ? first : await getTicketPage({ page: p, mine, status, hideStatuses });

    check(
      `page ${p} reports itself as page ${p}`,
      page.position.page === p,
      `got ${page.position.page}`,
    );
    check(
      `page ${p} totals are stable`,
      page.position.total === first.position.total,
      `${page.position.total} vs ${first.position.total}`,
    );

    const rows = [
      ...claimRows(environments, accounts, page.claims, directory),
      ...boardRows(page.issues, environments, accounts, directory),
    ];

    // A full page is exactly perPage rows; only the last may be short.
    const expected =
      p < first.position.pageCount
        ? TICKETS_PER_PAGE
        : first.position.total - (p - 1) * TICKETS_PER_PAGE;
    check(`page ${p} holds ${expected} row(s)`, rows.length === expected, `got ${rows.length}`);
    check(
      `page ${p} from/to match its rows`,
      page.position.to - page.position.from + 1 === rows.length || rows.length === 0,
      `from ${page.position.from} to ${page.position.to}, ${rows.length} rows`,
    );

    keys.push(...keysOf(rows));
    all.push(...rows);
  }

  return {
    keys,
    rows: all,
    totals: `${first.position.total} total, ${first.holdingTotal} holding, ${first.issueTotal} issues`,
  };
}

// ---------------------------------------------------------------- everybody's

{
  console.log("── Active tickets: every page against the old in-memory list ──");

  const unpaged = [
    ...claimRows(environments, accounts, claims, directory),
    ...boardRows(issues, environments, accounts, directory),
  ];
  const expected = keysOf(unpaged);

  const { keys, rows: pagedRows, totals } = await walk(null);
  console.log(`  ${totals}`);

  check("no row appears on two pages", new Set(keys).size === keys.length);
  check(
    "every ticket on the board is on some page",
    new Set(keys).size === expected.length,
    `${new Set(keys).size} paged vs ${expected.length} on the board`,
  );
  check(
    "the set of tickets is identical",
    [...keys].sort().join("|") === [...expected].sort().join("|"),
  );

  // Order is checked as a separate claim from membership, because a wrong
  // ORDER BY that still returns every row would pass the checks above.
  const pagedSort = sortKeys(pagedRows);
  const unpagedSort = sortKeys(unpaged);
  const differs = pagedSort.findIndex((k, i) => k !== unpagedSort[i]);
  check(
    "the order matches the unpaged list, position for position, on the sort key",
    differs === -1,
    differs === -1
      ? ""
      : `first differs at ${differs}: paged ${keys[differs]} (${pagedSort[differs]}), ` +
        `unpaged ${expected[differs]} (${unpagedSort[differs]})`,
  );

  // And the paged order is itself a valid "frees soonest first": non-decreasing
  // end times within each block, with the never-ending ones last. This is what
  // would catch an ORDER BY that agreed with the old list by accident.
  for (const block of ["claim", "issue"] as const) {
    const within = pagedRows.filter((r) => (block === "claim" ? r.holding : !r.holding));
    const ks = sortKeys(within);
    const bad = ks.findIndex((k, i) => i > 0 && k < ks[i - 1]);
    check(
      `${block}s are ordered soonest-to-free first, never-ending last`,
      bad === -1,
      bad === -1 ? "" : `${ks[bad - 1]} came before ${ks[bad]}`,
    );
  }

  // The tiebreak that makes OFFSET safe. Rows tying on BOTH old sort columns
  // are the ones that used to come back in an arbitrary order.
  const stamp = (v: string | null | undefined) => (v ? new Date(v).toISOString() : "~none");
  const tied = claims.filter(
    (c) =>
      claims.filter(
        (o) => stamp(o.endTime) === stamp(c.endTime) && stamp(o.claimedAt) === stamp(c.claimedAt),
      ).length > 1,
  );
  console.log(
    `  ${tied.length} claim(s) tie on end_time AND claimed_at — ` +
      "the ties `id ASC` exists to break",
  );

  // Claims first, then issues — the rule the block slicing depends on.
  const lastClaim = keys.reduce((acc, k, i) => (k.startsWith("claim:") ? i : acc), -1);
  const firstIssue = keys.findIndex((k) => k.startsWith("issue:"));
  check(
    "every claim sorts before every issue",
    firstIssue === -1 || lastClaim < firstIssue,
    `last claim at ${lastClaim}, first issue at ${firstIssue}`,
  );
}

// ----------------------------------------------------------- a stale page and
// ------------------------------------------------------------ an absent one

{
  console.log("\n── Out-of-range pages ──");

  const last = await getTicketPage({ page: 1 });
  const beyond = await getTicketPage({ page: 9999 });

  check(
    "page 9999 clamps to the last page",
    beyond.position.page === last.position.pageCount,
    `got ${beyond.position.page} of ${last.position.pageCount}`,
  );
  check(
    "the clamped page still has rows",
    beyond.claims.length + beyond.issues.length > 0 || last.position.total === 0,
  );

  const zero = await getTicketPage({ page: 0 });
  check("page 0 clamps to page 1", zero.position.page === 1, `got ${zero.position.page}`);
}

// ---------------------------------------------------------------- the filter

{
  console.log("\n── The `mine` predicate against claimIsMine() ──");

  const empty = await getTicketPage({ page: 1, mine: [] });
  check(
    "an empty identity set matches nothing",
    empty.position.total === 0,
    `got ${empty.position.total}`,
  );

  const users = await listAuthUsers();
  console.log(`  ${users.length} account(s) can sign in`);

  for (const user of users) {
    const values = identityValues(user, directory);

    // What claimIsMine() says, over the whole board.
    const unpaged = [
      ...claimRows(environments, accounts, claims, directory),
      ...boardRows(issues, environments, accounts, directory),
    ].filter((row) => claimIsMine(row.claim, values, directory));
    const expected = keysOf(unpaged);

    const { keys, rows: pagedRows } = await walk([...values]);

    const label = `${user.username} (${values.size} identity value(s), ${expected.length} ticket(s))`;
    check(
      `${label}: SQL and claimIsMine() agree on which tickets`,
      [...keys].sort().join("|") === [...expected].sort().join("|"),
      `SQL ${keys.length} vs JS ${expected.length}` +
        `\n      only in SQL: ${keys.filter((k) => !expected.includes(k)).join(", ") || "—"}` +
        `\n      only in JS:  ${expected.filter((k) => !keys.includes(k)).join(", ") || "—"}`,
    );
    check(
      `${label}: order matches on the sort key`,
      sortKeys(pagedRows).join("|") === sortKeys(unpaged).join("|"),
    );
    console.log(`  ${label}`);
  }
}

// ----------------------------------------------------------- the status chips

{
  console.log("\n── The status chips against the rows they count ──");

  const all = [
    ...claimRows(environments, accounts, claims, directory),
    ...boardRows(issues, environments, accounts, directory),
  ];
  const first = await getTicketPage({ page: 1 });

  const chipTotal = first.statuses.reduce((n, entry) => n + entry.total, 0);
  check(
    "the chips add up to the whole list",
    chipTotal === first.position.total,
    `${chipTotal} across ${first.statuses.length} chip(s) vs ${first.position.total} rows`,
  );

  // Every row is filed under exactly one chip, and statusKey() is what files
  // it. This is the JS side of the GROUP BY expression.
  const js = new Map<string, number>();
  for (const row of all) js.set(statusKey(row.claim.status), (js.get(statusKey(row.claim.status)) ?? 0) + 1);

  check(
    "SQL and statusKey() bucket the board identically",
    first.statuses.length === js.size && first.statuses.every((e) => js.get(e.key) === e.total),
    `SQL ${first.statuses.map((e) => `${e.key}=${e.total}`).join(", ")}` +
      `\n      JS  ${[...js].map(([k, n]) => `${k}=${n}`).join(", ")}`,
  );

  const chipKeys = first.statuses.map((e) => e.key).join("|");

  for (const entry of first.statuses) {
    // The GROUP BY says how many; the WHERE says which. They are different
    // expressions over the same column, so both are checked against the rows.
    const expected = keysOf(all.filter((row) => statusKey(row.claim.status) === entry.key));
    const filtered = await getTicketPage({ page: 1, status: entry.key });
    const { keys } = await walk(null, entry.key);

    check(
      `${entry.status}: the chip count is the pager's total`,
      filtered.position.total === entry.total,
      `chip ${entry.total} vs pager ${filtered.position.total}`,
    );
    check(
      `${entry.status}: every page of the filter is exactly the rows at it`,
      [...keys].sort().join("|") === [...expected].sort().join("|"),
      `SQL ${keys.length} vs JS ${expected.length}`,
    );
    check(
      `${entry.status}: holding + issues splits the same way the blocks do`,
      entry.holding === filtered.holdingTotal && entry.issues === filtered.issueTotal,
      `chip ${entry.holding}/${entry.issues} vs page ${filtered.holdingTotal}/${filtered.issueTotal}`,
    );
    // The chip row must NOT narrow under its own filter, or every other chip
    // would read zero and picking a second status would be impossible.
    check(
      `${entry.status}: the chips still list every status`,
      filtered.statuses.map((e) => e.key).join("|") === chipKeys,
      `${filtered.statuses.length} chip(s) under the filter vs ${first.statuses.length}`,
    );
  }

  // A status straight off a URL: any casing, and possibly one nobody is at.
  if (first.statuses.length) {
    const one = first.statuses[0]!;
    const shouted = await getTicketPage({ page: 1, status: one.status.toUpperCase() });
    check(
      "the filter is case-insensitive, as Jira's own casing requires",
      shouted.position.total === one.total,
      `${shouted.position.total} vs ${one.total}`,
    );
  }

  const bogus = await getTicketPage({ page: 1, status: "no status anybody is at" });
  check(
    "a status nobody is at is an empty page, not an error",
    bogus.position.total === 0 && bogus.claims.length === 0 && bogus.issues.length === 0,
    `${bogus.position.total} rows`,
  );
  check(
    "and it still offers the chips to get back out of it",
    bogus.statuses.map((e) => e.key).join("|") === chipKeys,
  );

  console.log(`  ${first.statuses.length} status(es): ${first.statuses.map((e) => `${e.status} ${e.total}`).join(", ")}`);
}

// -------------------------------------------- both filters at once, per person

{
  console.log("\n── `mine` and `status` together ──");

  const users = await listAuthUsers();

  for (const user of users) {
    const values = identityValues(user, directory);
    const mine = [...values];
    const theirs = [
      ...claimRows(environments, accounts, claims, directory),
      ...boardRows(issues, environments, accounts, directory),
    ].filter((row) => claimIsMine(row.claim, values, directory));

    const page = await getTicketPage({ page: 1, mine });

    // Their chips are counted over THEIR list, not the board's.
    const js = new Map<string, number>();
    for (const row of theirs) js.set(statusKey(row.claim.status), (js.get(statusKey(row.claim.status)) ?? 0) + 1);

    check(
      `${user.username}: the chips bucket only their own tickets`,
      page.statuses.length === js.size && page.statuses.every((e) => js.get(e.key) === e.total),
      `SQL ${page.statuses.map((e) => `${e.key}=${e.total}`).join(", ") || "—"}` +
        `\n      JS  ${[...js].map(([k, n]) => `${k}=${n}`).join(", ") || "—"}`,
    );

    for (const entry of page.statuses) {
      const expected = keysOf(theirs.filter((row) => statusKey(row.claim.status) === entry.key));
      const { keys } = await walk(mine, entry.key);
      check(
        `${user.username} · ${entry.status}: both filters narrow together`,
        [...keys].sort().join("|") === [...expected].sort().join("|"),
        `SQL ${keys.length} vs JS ${expected.length}`,
      );
    }

    console.log(
      `  ${user.username}: ${page.statuses.map((e) => `${e.status} ${e.total}`).join(", ") || "nothing assigned"}`,
    );
  }
}

// --------------------------------------------------------------- the hide list

{
  console.log("\n── `hideStatuses`, the rule that used to live in the JQL ──");

  const all = [
    ...claimRows(environments, accounts, claims, directory),
    ...boardRows(issues, environments, accounts, directory),
  ];
  const first = await getTicketPage({ page: 1 });

  // Nothing to hide must hide nothing. Both spellings of "nothing" reach this
  // query — Settings can hold an empty list, and My tickets passes null.
  for (const [label, hideStatuses] of [["null", null], ["an empty list", []]] as const) {
    const page = await getTicketPage({ page: 1, hideStatuses });
    check(
      `${label} hides nothing`,
      page.position.total === first.position.total,
      `${page.position.total} vs ${first.position.total}`,
    );
  }

  for (const entry of first.statuses) {
    const hidden = await getTicketPage({ page: 1, hideStatuses: [entry.key] });
    const expected = keysOf(all.filter((row) => statusKey(row.claim.status) !== entry.key));

    check(
      `hiding ${entry.status} removes exactly its ${entry.total} row(s)`,
      hidden.position.total === first.position.total - entry.total,
      `${hidden.position.total} vs ${first.position.total} - ${entry.total}`,
    );
    check(
      `hiding ${entry.status} drops its chip`,
      !hidden.statuses.some((e) => e.key === entry.key),
      `chips: ${hidden.statuses.map((e) => e.key).join(", ")}`,
    );
    check(
      `hiding ${entry.status}: the chips still add up to the pager`,
      hidden.statuses.reduce((n, e) => n + e.total, 0) === hidden.position.total,
    );

    const { keys } = await walk(null, null, [entry.key]);
    check(
      `hiding ${entry.status}: every page is exactly the rows NOT at it`,
      [...keys].sort().join("|") === [...expected].sort().join("|"),
      `SQL ${keys.length} vs JS ${expected.length}`,
    );
  }

  // The real list, in the casing Settings stores it in — the case that actually
  // ships. `statusKey()` inside getTicketPage() is what makes it match.
  const settings = await getSettings();
  const configured = settings.jira.ignoredStatuses.filter(Boolean);
  const shipped = await getTicketPage({ page: 1, hideStatuses: configured });
  const survivors = all.filter(
    (row) => !configured.map(statusKey).includes(statusKey(row.claim.status)),
  );

  check(
    "the configured list matches Jira's own casing",
    shipped.position.total === survivors.length,
    `${shipped.position.total} vs ${survivors.length}`,
  );
  const { keys: shippedKeys } = await walk(null, null, configured);
  check(
    "Active tickets shows exactly what is not at a hidden status",
    [...shippedKeys].sort().join("|") === [...keysOf(survivors)].sort().join("|"),
  );

  // Hiding everything is a legitimate, if silly, configuration: it must empty
  // the board rather than fall through to showing all of it.
  const nothingLeft = await getTicketPage({
    page: 1,
    hideStatuses: first.statuses.map((e) => e.key),
  });
  check(
    "hiding every status leaves an empty board, not a full one",
    nothingLeft.position.total === 0 && nothingLeft.statuses.length === 0,
    `${nothingLeft.position.total} rows, ${nothingLeft.statuses.length} chip(s)`,
  );

  console.log(
    `  Settings hides ${configured.join(", ") || "nothing"} — ` +
      `${first.position.total} row(s) on the board, ${shipped.position.total} on Active tickets`,
  );
}

// ----------------------------------------------------------------- the report

console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ the paged query returns exactly what the unpaged code did");
