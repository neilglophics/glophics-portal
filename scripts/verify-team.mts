/**
 * Does the roster agree with the drill-down, and with the board?
 * npm run verify:team
 *
 * /team buckets every ticket per person in JavaScript; /team/[personId] pages
 * the same person's tickets out of Postgres. Those are two different code paths
 * over one rule, and a roster that says "3" above a list of 2 is the failure
 * this script exists to catch — against the real database rather than against a
 * fixture that agrees with whatever was written.
 *
 * What it checks:
 *
 *   1. THE GATE. `oversee` is superadmin-only, and every other role is refused.
 *      A capability is only worth anything if the list says what it is meant to,
 *      so this is asserted rather than assumed.
 *
 *   2. ROSTER == DRILL-DOWN. For every person on the board, the tickets bucketed
 *      into their row are exactly the tickets getTicketPage() returns for their
 *      identity strings — walked page by page, not just counted.
 *
 *   3. NOTHING LOST, NOTHING DOUBLED. Every ticket on the board lands somewhere:
 *      on at least one person, on an unmatched name, or in "unassigned". And a
 *      ticket appears at most once in any single person's row, which is the
 *      failure mode when somebody is named twice on one claim — once by
 *      directory id and once by a label that resolves to them.
 *
 *   4. AVAILABILITY IS WHAT IT CLAIMS. free means no live work and nothing held;
 *      busy means something held; overloaded means OVERLOADED_AT or more. Read
 *      back off the row rather than recomputed the same way it was computed.
 *
 *   5. THE SUMMARY ADDS UP. The tiles are the roster counted, and every person
 *      is in exactly one availability bucket.
 *
 * Read-only: it takes no locks and writes nothing.
 */

import { loadEnv, requireEnv } from "./_env";

loadEnv();
requireEnv("DATABASE_URL");

const { getBoard, getJiraIssues } = await import("@/lib/db/queries/board");
const { getTicketPage } = await import("@/lib/db/queries/tickets");
const { listAuthUsers } = await import("@/lib/db/queries/auth");
const { directoryIdentityValues } = await import("@/lib/shared/mine");
const { AUTH_ROLES, roleCan } = await import("@/lib/shared/roles");
const { boardRows, claimRows } = await import("@/lib/shared/view-model");
const { OVERLOADED_AT, buildRoster, isLive } = await import("@/lib/shared/workload");

let passed = 0;
const failures: string[] = [];

function check(what: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${what} — ${detail}` : what);
}

const { accounts, environments, claims, directory, settings } = await getBoard();
const issues = await getJiraIssues();
const logins = await listAuthUsers();

const tickets = [
  ...claimRows(environments, accounts, claims, directory),
  ...boardRows(issues, environments, accounts, directory),
];

const roster = buildRoster({ directory, tickets, jira: settings.jira, logins });

console.log(
  `board: ${claims.length} claims, ${issues.length} cached issues, ` +
    `${directory.length} people, ${logins.length} login(s)\n`,
);

/** The row identity the ticket tables key on, so two lists compare as text. */
const keysOf = (rows: { claim: { id: string }; holding: boolean }[]): string[] =>
  rows.map((row) => `${row.holding ? "claim" : "issue"}:${row.claim.id}`);

// ------------------------------------------------------------------ 1. the gate

console.log("the gate");
for (const role of AUTH_ROLES) {
  const expected = role.id === "superadmin";
  check(
    `${role.id} ${expected ? "holds" : "does not hold"} oversee`,
    roleCan(role.id, "oversee") === expected,
  );
}
check("an unknown role holds nothing", !roleCan("not-a-role", "oversee"));
check("a null role holds nothing", !roleCan(null, "oversee"));
console.log(`  ${AUTH_ROLES.length} role(s) checked\n`);

// -------------------------------------------------- 2. roster == the drill-down

console.log("every person: the roster row matches the paged drill-down");

/** Walk every page of one person's drill-down, the way the page does. */
async function walk(mine: string[]): Promise<string[]> {
  const first = await getTicketPage({ page: 1, mine });
  const keys = keysOf([
    ...claimRows(environments, accounts, first.claims, directory),
    ...boardRows(first.issues, environments, accounts, directory),
  ]);

  for (let page = 2; page <= first.position.pageCount; page += 1) {
    const next = await getTicketPage({ page, mine });
    keys.push(
      ...keysOf([
        ...claimRows(environments, accounts, next.claims, directory),
        ...boardRows(next.issues, environments, accounts, directory),
      ]),
    );
  }

  return keys;
}

for (const row of roster.rows) {
  const person = directory.find((entry) => entry.id === row.person.id)!;
  const values = [...directoryIdentityValues(person)];

  const mine = keysOf([...row.holding, ...row.open]);
  // The roster's `open` excludes finished work, which the drill-down still
  // lists — it is that person's whole ticket history in the sync window. So the
  // comparison is against everything bucketed to them, done included.
  const bucketed = mine.length + row.doneCount;

  const paged = await walk(values);

  check(
    `${person.name}: the drill-down returns as many tickets as the roster bucketed`,
    paged.length === bucketed,
    `paged ${paged.length} vs roster ${bucketed} (${mine.length} live + ${row.doneCount} finished)`,
  );

  // The live ones must be a subset, name for name, not merely the same count.
  const missing = mine.filter((key) => !paged.includes(key));
  check(
    `${person.name}: every ticket on the roster row is in the drill-down`,
    missing.length === 0,
    `missing from the page: ${missing.join(", ")}`,
  );

  // No ticket twice in one row — the "named by id AND by a label that resolves
  // to the same person" case.
  const all = keysOf([...row.holding, ...row.open]);
  check(
    `${person.name}: no ticket counted twice`,
    new Set(all).size === all.length,
    `${all.length} entries, ${new Set(all).size} distinct`,
  );
}
console.log(`  ${roster.rows.length} person(s) checked\n`);

// ------------------------------------------- 3. nothing lost, nothing doubled

console.log("coverage: every ticket lands somewhere");

const placed = new Set<string>();
for (const row of [...roster.rows, ...roster.unmatched]) {
  for (const key of keysOf([...row.holding, ...row.open])) placed.add(key);
}
for (const key of keysOf(roster.unassigned)) placed.add(key);

const live = tickets.filter((row) => isLive(row, settings.jira));
const lost = keysOf(live).filter((key) => !placed.has(key));

check(
  "every LIVE ticket is on somebody, on an unmatched name, or unassigned",
  lost.length === 0,
  `${lost.length} unaccounted for: ${lost.slice(0, 10).join(", ")}`,
);

// An unassigned ticket must genuinely name nobody: peopleOf() is what the
// bucketing trusts, so this is the assertion that trust is warranted.
for (const row of roster.unassigned) {
  check(
    `${row.claim.id} is unassigned because nobody is on it`,
    row.people.length === 0,
    `peopleOf() returned ${row.people.map((p) => p.name).join(", ")}`,
  );
}

// And an unmatched pseudo-person must be flagged as one, or the roster is
// quietly presenting a Jira label as a member of the team.
for (const row of roster.unmatched) {
  check(`"${row.person.name}" is flagged unmatched`, row.person.unmatched === true);
  check(`"${row.person.name}" has no login attached`, row.loginId === null);
}
console.log(
  `  ${live.length} live ticket(s), ${roster.unassigned.length} unassigned, ` +
    `${roster.unmatched.length} unmatched name(s)\n`,
);

// ------------------------------------------------ 4. availability means what it says

console.log("availability");
for (const row of [...roster.rows, ...roster.unmatched]) {
  const held = row.holding.length;
  const expected =
    held >= OVERLOADED_AT ? "overloaded" : held > 0 ? "busy" : row.open.length ? "assigned" : "free";

  check(
    `${row.person.name}: reads ${row.availability}`,
    row.availability === expected,
    `${held} held, ${row.open.length} open — expected ${expected}`,
  );

  if (row.availability === "free") {
    check(`${row.person.name}: free means nothing held and nothing live`, !held && !row.open.length);
  }
  if (row.availability === "busy" || row.availability === "overloaded") {
    check(`${row.person.name}: holding means an environment is named`, row.environments.length > 0);
  }
  // soonestFree is about held environments only. Somebody holding nothing must
  // not report a countdown, or the roster promises a box that frees up.
  if (!held) {
    check(`${row.person.name}: holds nothing, so frees nothing`, row.soonestFree === null);
  }
}
console.log(`  ${roster.rows.length + roster.unmatched.length} row(s) checked\n`);

// ----------------------------------------------------------- 5. the summary adds up

console.log("the summary tiles");
const { summary } = roster;
const byState = (state: string) => roster.rows.filter((row) => row.availability === state).length;

check("people == the directory", summary.people === directory.length);
check("free is counted right", summary.free === byState("free"));
check("assigned is counted right", summary.assigned === byState("assigned"));
check("busy includes the overloaded", summary.busy === byState("busy") + byState("overloaded"));
check("overloaded is counted right", summary.overloaded === byState("overloaded"));
check(
  "every person is in exactly one bucket",
  summary.free + summary.assigned + summary.busy === summary.people,
  `${summary.free} + ${summary.assigned} + ${summary.busy} != ${summary.people}`,
);
check("unassigned matches the list", summary.unassignedTickets === roster.unassigned.length);
check("unmatched matches the list", summary.unmatchedNames === roster.unmatched.length);

// ----------------------------------------------------------------- the report

console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("✓ the roster and the per-person drill-down tell the same story");
