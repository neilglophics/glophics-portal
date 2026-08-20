/**
 * Are the Pusher credentials actually usable?  npm run verify:pusher
 *
 * Worth its own script because the failure is invisible from inside the app.
 * `authorizeChannel` is a LOCAL HMAC: it succeeds whatever the secret is, the
 * socket still connects (the app key is public and valid for connecting), and the
 * connection indicator happily says "Live". Only Pusher's edge knows the
 * signature is wrong, and it tells the browser, not the server.
 *
 * So this calls Pusher's REST API, which needs the real secret to authenticate.
 * A 401 here is the whole explanation for "realtime is not working".
 */
import Pusher from "pusher";
import { loadEnv } from "./_env";

loadEnv();

const appId = process.env.PUSHER_APP_ID;
const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
const secret = process.env.PUSHER_SECRET;
const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

const mask = (v?: string) => (!v ? "MISSING" : `${v.slice(0, 4)}…${v.slice(-4)} (len ${v.length})`);

console.log("  PUSHER_APP_ID              ", mask(appId));
console.log("  NEXT_PUBLIC_PUSHER_KEY     ", mask(key));
console.log("  PUSHER_SECRET              ", mask(secret));
console.log("  NEXT_PUBLIC_PUSHER_CLUSTER ", cluster ?? "MISSING");

if (!appId || !key || !secret || !cluster) {
  console.log("\n  Realtime is OFF (incomplete configuration). The app still works;");
  console.log("  changes just need a manual refresh in other tabs.");
  process.exit(0);
}

if (secret === key) {
  console.log("\n  ❌ PUSHER_SECRET is the same value as NEXT_PUBLIC_PUSHER_KEY.");
  console.log("     Those are two DIFFERENT values in Pusher — dashboard → App Keys.");
  console.log("     The key is public and ships in the browser; the secret signs");
  console.log("     subscription authorisations and must never be public.");
}

try {
  const res = await new Pusher({ appId, key, secret, cluster, useTLS: true }).get({ path: "/channels" });
  if (res.status === 200) {
    console.log("\n  ✅ Credentials accepted by Pusher. Realtime should work.");
    process.exit(0);
  }
  console.log(`\n  ❌ Pusher answered ${res.status}.`);
} catch (err) {
  console.log(`\n  ❌ Pusher rejected the credentials (${(err as Error).message}).`);
}

console.log("     Copy all four values fresh from the Pusher dashboard into .env,");
console.log("     AND into the Vercel environment, then restart / redeploy.");
process.exit(1);
