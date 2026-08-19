/**
 * Serving the app's own files, and nothing else.
 *
 * Two roots, and they are the whole list:
 *   /            → public/   the app — index.html and public/js/**
 *   /shared/…    → shared/   data.js, the one module both sides run
 *
 * This used to serve from the repo root, which is also where auth.json,
 * jira-config.json and the board lived. What kept those from being handed to
 * anyone who guessed a filename was MIME_TYPES having no ".json" entry — a
 * list that had to stay correct forever, against a directory that kept
 * gaining files. Now those files are simply not under a root this can read,
 * and the extension allowlist below is the second lock rather than the only
 * one.
 */

const fs = require("fs");
const path = require("path");
const { PUBLIC_DIR, SHARED_DIR } = require("./paths.js");

// What may be handed out, by extension. Note what is still absent: ".json".
// Nothing the browser needs is JSON — the board arrives over /api/state — so
// a request for one is a request for something it has no business reading.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const SHARED_PREFIX = "/shared/";

/**
 * Which root a path belongs to, and where under it. Returns null when the
 * result would escape that root — `..` in a URL, or an encoded one.
 */
function resolveFile(urlPath) {
  const [root, relative] = urlPath.startsWith(SHARED_PREFIX)
    ? [SHARED_DIR, urlPath.slice(SHARED_PREFIX.length - 1)]
    : [PUBLIC_DIR, urlPath === "/" ? "/index.html" : urlPath];

  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch (err) {
    return null;   // a malformed escape is not a path worth guessing at
  }

  const filePath = path.normalize(path.join(root, decoded));
  // path.sep, not a bare prefix test: "/publicX" starts with "/public" too.
  return filePath === root || filePath.startsWith(root + path.sep) ? filePath : null;
}

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const filePath = resolveFile(urlPath);

  const notFound = () => {
    // 404 rather than 403, so a refusal says nothing about what happens to
    // be on disk.
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };

  if (!filePath) { notFound(); return; }

  // Only the extensions above, and never a dotfile.
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME_TYPES[ext] || path.basename(filePath).startsWith(".")) { notFound(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { notFound(); return; }
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] });
    res.end(data);
  });
}

module.exports = { serveStatic, MIME_TYPES };
