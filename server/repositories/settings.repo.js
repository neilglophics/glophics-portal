/**
 * Application settings and the Jira connection.
 *
 * Both are single-row tables. The row is created by migration 006, so every
 * read here can assume it exists -- there is no "or insert the default"
 * branch anywhere above this file.
 */

const { jsonObject, toJson, bool, isoOrNull } = require("../db/columns.js");

function toSettings(row) {
  return {
    defaultBookingHours: Number(row.default_booking_hours),
    onExpiry: row.on_expiry,
    assignWholeEnv: bool(row.assign_whole_env),
    jira: jsonObject(row.jira)
  };
}

async function get(db) {
  const row = await db.one(
    "select default_booking_hours, on_expiry, assign_whole_env, jira from app_settings where id = 1"
  );
  if (!row) throw new Error("app_settings row is missing; migration 006 did not run.");
  return toSettings(row);
}

/**
 * Applies a partial update. `jira` is merged shallowly by the service before it
 * gets here -- this function writes whatever it is given, so that a single
 * checkbox does not require the caller to send the other eight fields.
 */
async function update(db, patch) {
  const sets = ["updated_at = current_timestamp(3)"];
  const params = [];
  if (patch.defaultBookingHours !== undefined) {
    sets.push("default_booking_hours = ?");
    params.push(patch.defaultBookingHours);
  }
  if (patch.onExpiry !== undefined) {
    sets.push("on_expiry = ?");
    params.push(patch.onExpiry);
  }
  if (patch.assignWholeEnv !== undefined) {
    sets.push("assign_whole_env = ?");
    params.push(patch.assignWholeEnv ? 1 : 0);
  }
  if (patch.jira !== undefined) {
    sets.push("jira = ?");
    params.push(toJson(patch.jira));
  }
  if (params.length) {
    await db.run(`update app_settings set ${sets.join(", ")} where id = 1`, params);
  }
  return get(db);
}

// ------------------------------------------------------- Jira connection ----

async function getJiraConnection(db) {
  const row = await db.one("select base_url, email, updated_at from jira_connection where id = 1");
  if (!row) throw new Error("jira_connection row is missing; migration 006 did not run.");
  return { baseUrl: row.base_url, email: row.email, updatedAt: isoOrNull(row.updated_at) };
}

async function setJiraConnection(db, { baseUrl, email }) {
  await db.run(
    `update jira_connection
        set base_url = coalesce(?, base_url),
            email = coalesce(?, email),
            updated_at = current_timestamp(3)
      where id = 1`,
    [baseUrl ?? null, email ?? null]
  );
  return getJiraConnection(db);
}

module.exports = { toSettings, get, update, getJiraConnection, setJiraConnection };
