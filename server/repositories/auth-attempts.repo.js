/**
 * Sign-in attempts.
 *
 * Append-only, and in the database rather than in memory. The previous
 * implementation counted failures in a Map, so every restart forgave every
 * attacker -- and a process that can be made to crash is a process whose
 * rate limiting can be reset at will.
 */

async function record(db, { username, ip, outcome, userAgent }) {
  await db.run(
    `insert into auth_attempts (username_norm, client_ip, outcome, user_agent)
     values (lower(trim(?)), ?, ?, ?)`,
    [username || "", ip ?? null, outcome, (userAgent || "").slice(0, 512) || null]
  );
}

/**
 * Failures for this username since its last success.
 *
 * Defining the window as "since the last success" is what makes a successful
 * sign-in clear the backoff curve without deleting anything -- the evidence
 * stays, the penalty does not.
 */
/**
 * Returns both the count and when the most recent one happened. The count
 * alone cannot answer "has this account served its penalty" -- only "how many
 * times has it failed" -- and the backoff has to release once its wait has
 * actually elapsed, not stay locked for the rest of the window regardless of
 * how long ago the failure was.
 */
async function failuresSinceLastSuccess(db, username, windowMs) {
  const since = new Date(Date.now() - windowMs);
  const row = await db.one(
    `select count(*) as total, max(attempted_at) as last_failed_at
       from auth_attempts
      where username_norm = lower(trim(?))
        and attempted_at >= ?
        and outcome in ('bad-password', 'no-such-user', 'deactivated')
        and attempted_at > coalesce((
          select max(attempted_at) from auth_attempts
           where username_norm = lower(trim(?)) and outcome = 'success'
        ), '1970-01-01')`,
    [username, since, username]
  );
  return {
    count: Number(row.total),
    lastFailedAt: row.last_failed_at ? new Date(row.last_failed_at) : null
  };
}

/**
 * How many *different* usernames have failed from this address.
 *
 * Counting distinct usernames rather than raw failures is the whole point.
 * Everyone in an office shares one public address, so a raw-failure counter
 * would let three colleagues mistyping their passwords lock out the building.
 * Nobody legitimately fails against ten different usernames.
 */
async function distinctUsernamesFailedFromIp(db, ip, windowMs) {
  if (!ip) return { count: 0, lastFailedAt: null };
  const since = new Date(Date.now() - windowMs);
  const row = await db.one(
    `select count(distinct username_norm) as total, max(attempted_at) as last_failed_at
       from auth_attempts
      where client_ip = ? and attempted_at >= ?
        and outcome in ('bad-password', 'no-such-user')`,
    [ip, since]
  );
  return {
    count: Number(row.total),
    lastFailedAt: row.last_failed_at ? new Date(row.last_failed_at) : null
  };
}

/** Total failures across every account. The last resort when the front door
 *  is open to the internet and something is spraying it. */
async function globalFailures(db, windowMs) {
  const since = new Date(Date.now() - windowMs);
  const row = await db.one(
    `select count(*) as total, max(attempted_at) as last_failed_at
       from auth_attempts
      where attempted_at >= ? and outcome in ('bad-password', 'no-such-user')`,
    [since]
  );
  return {
    count: Number(row.total),
    lastFailedAt: row.last_failed_at ? new Date(row.last_failed_at) : null
  };
}

/** Clears the penalty for one account without erasing the record of why. */
async function forgive(db, username) {
  await db.run(
    `insert into auth_attempts (username_norm, client_ip, outcome, user_agent)
     values (lower(trim(?)), null, 'success', 'cli:unlock')`,
    [username]
  );
}

async function deleteOlderThan(db, cutoff) {
  const result = await db.run("delete from auth_attempts where attempted_at < ?", [cutoff]);
  return result.affectedRows;
}

module.exports = {
  record, failuresSinceLastSuccess, distinctUsernamesFailedFromIp,
  globalFailures, forgive, deleteOlderThan
};
