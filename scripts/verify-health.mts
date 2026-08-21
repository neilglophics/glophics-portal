/**
 * Run one health pass from the command line.  npm run verify:health
 *
 * The pass itself runs inside a serverless function where the only trace it
 * leaves is a line in the Vercel log, so "why does the board say that?" is
 * otherwise hard to answer. This does exactly what /api/cron/health does —
 * same code, same timeout, same rules — and prints what it measured, including
 * every repository it could not reach and how long the whole thing took.
 *
 * It WRITES. `health` and `health_checked_at` are updated for real, which is
 * also what makes it useful as a way to seed a fresh database with true states
 * instead of whatever the import carried over.
 *
 * What it deliberately does NOT do is publish or revalidate: there is no request
 * to attribute the change to and no Next cache in this process. Open tabs will
 * pick it up on their next refresh rather than instantly.
 */

import { loadEnv, requireEnv } from "./_env";

loadEnv();
requireEnv("DATABASE_URL", "Point it at your Neon branch (the POOLED connection string).");

const { runHealthChecks } = await import("../lib/health/check.ts");
const { HEALTH_CHECK_TIMEOUT_MS } = await import("../lib/shared/health.ts");

console.log(`\n  Probing every configured repository (${HEALTH_CHECK_TIMEOUT_MS / 1000}s timeout each)…\n`);

const pass = await runHealthChecks({ force: true });

console.log(`  ✅ online        ${pass.online}`);
console.log(`  ❌ offline       ${pass.offline}`);
console.log(`  ·  no URL set    ${pass.unconfigured}`);
console.log(`  ↻  changed       ${pass.changed.length}`);
console.log(`     took          ${(pass.durationMs / 1000).toFixed(1)}s`);
console.log(`     checked at    ${pass.checkedAt}`);

if (pass.changed.length) {
  console.log("\n  Changed since the last pass:");
  for (const change of pass.changed) {
    console.log(`    ${change.health.padEnd(13)} ${change.serverId} · ${change.repoName}`);
  }
}

if (pass.offline) {
  console.log(
    "\n  Offline means the request could not complete at all — DNS, refused, TLS or timeout.\n" +
      "  A 404 or a 500 still counts as online, because the box answered. If everything\n" +
      "  above is offline, suspect the network this ran from before suspecting the boxes.",
  );
}

process.exit(0);
