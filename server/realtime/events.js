/**
 * The event vocabulary.
 *
 * Every name here has a matching reducer in public/js/state.js. The two lists
 * are a contract: a browser that receives a type it has no reducer for gives up
 * on the delta and refetches the whole board, which is correct but wasteful, so
 * adding a type on the server without adding its reducer is a silent
 * performance regression rather than a visible break. Adding both together is
 * the whole discipline.
 */

const EVENTS = Object.freeze({
  // The full board. Sent as the first frame of a stream, and whenever a delta
  // would be larger or less reliable than simply starting again.
  SNAPSHOT: "board.snapshot",
  // "Something changed that I am not going to describe -- go and refetch."
  INVALIDATE: "board.invalidate",

  DIRECTORY_USER_UPSERTED: "directory-user.upserted",
  DIRECTORY_USER_DELETED: "directory-user.deleted",

  ACCOUNT_UPSERTED: "account.upserted",
  ACCOUNT_DELETED: "account.deleted",

  SERVER_UPSERTED: "server.upserted",
  SERVER_DELETED: "server.deleted",
  SERVER_REPO_HEALTH: "server-repo.health",

  NOTE_SET: "note.set",
  NOTE_CLEARED: "note.cleared",

  CLAIM_CREATED: "claim.created",
  CLAIM_UPDATED: "claim.updated",
  CLAIM_DELETED: "claim.deleted",
  CLAIMS_REPLACED: "claims.replaced",

  SETTINGS_UPDATED: "settings.updated",

  // Something changed in the Jira-derived lists.
  JIRA_SYNCED: "jira.synced",
  // Nothing changed, but the "synced Ns ago" indicator needs the new timestamp.
  // This exists so an idle poll costs sixty bytes per tab instead of the whole
  // board, which is what it cost before.
  JIRA_HEARTBEAT: "jira.heartbeat"
});

const ALL = Object.freeze(Object.values(EVENTS));

/**
 * How many entities a delta may describe before sending "refetch" instead.
 *
 * Past this point the delta stops being cheaper than the snapshot it is
 * standing in for, and every extra row is one more chance for the client and
 * server to disagree about the result.
 */
const MAX_DELTA_ENTITIES = 200;

module.exports = { EVENTS, ALL, MAX_DELTA_ENTITIES };
