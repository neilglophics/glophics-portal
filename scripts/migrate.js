#!/usr/bin/env node
/**
 * Migration CLI. `node scripts/migrate.js` applies everything pending;
 * `status` reports without touching anything.
 */
const { assertValid } = require("../server/config.js");
const migrate = require("../server/db/migrate.js");
const { close } = require("../server/db/client.js");

async function main() {
  assertValid();
  const command = process.argv[2] || "up";

  if (command === "status") {
    const rows = await migrate.status();
    for (const row of rows) {
      const when = row.appliedAt ? new Date(row.appliedAt).toISOString() : "";
      console.log(`${row.state.padEnd(8)} ${row.name} ${when}`);
    }
    const drifted = rows.filter((r) => r.state === "drifted");
    if (drifted.length) process.exitCode = 1;
    return;
  }

  if (command !== "up") {
    console.error(`Unknown command "${command}". Use: up | status`);
    process.exitCode = 2;
    return;
  }

  const applied = await migrate.run();
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Already up to date.");
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => close());
