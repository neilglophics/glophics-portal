/**
 * Application settings: booking defaults, what happens when a claim expires,
 * and the Jira workflow configuration.
 */

const { db } = require("../db/client.js");
const settingsRepo = require("../repositories/settings.repo.js");
const bus = require("../realtime/bus.js");
const { EVENTS } = require("../realtime/events.js");
const audit = require("./audit.service.js");
const rules = require("../../shared/rules.js");
const { ValidationError } = require("../http/errors.js");

async function get() {
  return settingsRepo.get(db);
}

/**
 * `patch.jira` is merged shallowly onto the existing object, matching
 * Object.assign(appData.settings.jira, partial) in the previous client --
 * so toggling one checkbox stays a one-key request rather than requiring the
 * caller to resend everything else.
 */
async function update(ctx, patch) {
  const errors = rules.validateSettings(patch);
  if (errors.length) throw new ValidationError(errors);

  const dbPatch = { ...patch };
  if (patch.jira !== undefined) {
    const current = await settingsRepo.get(db);
    dbPatch.jira = { ...current.jira, ...patch.jira };
  }

  const settings = await settingsRepo.update(db, dbPatch);

  await audit.record(db, audit.EVENTS.SETTINGS_CHANGED, ctx, {
    detail: { fields: Object.keys(patch) }
  });

  await bus.emit(EVENTS.SETTINGS_UPDATED, settings, { origin: ctx.clientId });
  return settings;
}

module.exports = { get, update };
