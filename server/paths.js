/**
 * Every path the server touches, resolved once from the repo root.
 *
 * Not `__dirname`. Modules here sit at two different depths (server/ and
 * server/routes/), so a path built from where the file happens to live would
 * mean two different directories depending on which module asked. It also
 * used to mean "wherever server.js is", which was the repo root — and a
 * handful of paths quietly depended on that being true.
 *
 * The split that matters is PUBLIC_DIR. The static handler can only read
 * from there and SHARED_DIR, so nothing else in the tree is reachable over
 * http at all — auth.json's password hashes and live session tokens,
 * jira-config.json's API token, the whole board in shared-data/. That used
 * to rest on a MIME extension allowlist that had to keep ".json" out
 * forever; now it rests on the files being somewhere the handler cannot
 * look. The allowlist is still there, as the second lock.
 */

const path = require("path");

const ROOT = path.join(__dirname, "..");

module.exports = {
  ROOT,

  // Served to the browser. The only directory a request can reach, together
  // with SHARED_DIR below.
  PUBLIC_DIR: path.join(ROOT, "public"),

  // data.js — the one module both sides run, so both sides must be able to
  // reach it: the server requires it, the browser loads it as /shared/data.js.
  SHARED_DIR: path.join(ROOT, "shared"),

  // Credentials and connection settings. Written at runtime, never served.
  CONFIG_DIR: path.join(ROOT, "config")
};
