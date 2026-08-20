/**
 * Verifies the password module against the hashes the previous JSON store
 * produced. If this fails, importing config/auth.json locks everybody out.
 */
const crypto = require("node:crypto");
const assert = require("node:assert");
const pw = require("../server/security/passwords.js");

// Reproduces server/auth-store.js exactly as it was.
function legacyCredentials(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

async function main() {
  const secret = "correct horse battery staple";

  // 1. A legacy hash must still verify, and must be flagged for rehash.
  const legacy = legacyCredentials(secret);
  const encoded = pw.encodeLegacy(legacy);
  const good = await pw.verify(secret, encoded);
  assert.equal(good.ok, true, "legacy hash must verify");
  assert.equal(good.needsRehash, true, "legacy params must be flagged stale");
  const bad = await pw.verify(secret + "x", encoded);
  assert.equal(bad.ok, false, "wrong password must not verify");

  // 2. A current hash round-trips and is not flagged.
  const current = await pw.hash(secret);
  const fresh = await pw.verify(secret, current);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.needsRehash, false);

  // 3. Two hashes of the same password differ (salted).
  assert.notEqual(current, await pw.hash(secret), "hashes must be salted");

  // 4. Malformed stored hashes fail closed, never throw, never pass.
  for (const junk of ["", "not-a-hash", "$scrypt$v=1$n=1$$", "$argon2$v=1$n=1,r=8,p=1$AA$AA", null, undefined]) {
    const r = await pw.verify("anything", junk);
    assert.equal(r.ok, false, `junk hash ${JSON.stringify(junk)} must not verify`);
  }

  // 5. Unicode normalisation: same password, different encodings.
  const composed = "café";              // e + combining acute
  const precomposed = "café";            // é
  const h = await pw.hash(composed);
  assert.equal((await pw.verify(precomposed, h)).ok, true, "NFKC must normalise");

  // 6. Whitespace is NOT trimmed away.
  const padded = await pw.hash(" secret ");
  assert.equal((await pw.verify("secret", padded)).ok, false, "must not trim");

  // 7. Timing: the no-such-user path must cost about the same as a real one.
  const t0 = process.hrtime.bigint();
  await pw.verify(secret, current);
  const real = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  await pw.burn(secret);
  const dummy = Number(process.hrtime.bigint() - t1) / 1e6;
  const ratio = Math.max(real, dummy) / Math.max(1, Math.min(real, dummy));
  assert.ok(ratio < 3, `timing must be comparable (real ${real.toFixed(0)}ms vs dummy ${dummy.toFixed(0)}ms)`);

  console.log(`passwords: all checks passed (verify ~${real.toFixed(0)}ms, dummy ~${dummy.toFixed(0)}ms)`);
}

main().catch((err) => { console.error("FAILED:", err.message); process.exitCode = 1; });
