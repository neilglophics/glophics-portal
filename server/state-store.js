/**
 * The board on disk.
 *
 * One file per section under shared-data/ — users.json, accounts.json,
 * servers.json, tickets.json, notes.json, settings.json — rather than one
 * shared-state.json holding all of them. Two reasons:
 *
 *   - A file you can read. `tickets` and `servers` are most of the board's
 *     bulk; the other four together are under 150 lines. Splitting them
 *     means opening the one you actually meant, and a diff that names the
 *     section that changed.
 *   - A write that touches only what moved. A health check changes one
 *     repo's `health` and nothing else, and it runs every 30 seconds — it
 *     now rewrites servers.json alone instead of the whole board.
 *
 * What is *not* here: the Jira-derived keys (JIRA_DERIVED_KEYS in
 * shared/data.js). Whatever a previous run left for those is stale the moment
 * the process stops, so they are never written and are reset on load; the
 * sync at boot refills them.
 *
 * Credentials are not here either — those live in auth.json, reached only
 * through auth-store.js. Nothing in shared-data/ is a secret in the
 * password sense, but it does carry internal URLs and every claim on the
 * board, which is why serveStatic refuses to hand out ".json" at all.
 */

const fs = require("fs");
const path = require("path");
const { buildDefaultAppData, migrateAppData, withoutJiraDerived, JIRA_DERIVED_KEYS } = require("../shared/data.js");

const { ROOT, DATA_DIR } = require("./paths.js");

// The single file every board before this one was kept in. Read once, split
// into the directory, and then archived rather than deleted — it is the only
// copy of a board that is not in git.
const LEGACY_FILE = path.join(ROOT, "shared-state.json");

/**
 * Which section lives in which file, and what a missing one means.
 *
 * `required` marks the three that *are* the board. A board with no servers
 * is not a board with an empty list of servers — it is a board we failed to
 * read, and defaulting it would quietly throw away every claim on it. The
 * same guard the single-file loader used (`parsed.users && parsed.accounts
 * && parsed.servers`), kept per file.
 *
 * The rest are optional because a board written by an older version really
 * can be without them, and migrateAppData() fills in exactly the shape each
 * one should have. Order is the order they are written in.
 */
const SECTIONS = [
  { key: "users",    file: "users.json",    required: true },
  { key: "accounts", file: "accounts.json", required: true },
  { key: "servers",  file: "servers.json",  required: true },
  { key: "settings", file: "settings.json", required: false },
  { key: "notes",    file: "notes.json",    required: false },
  { key: "tickets",  file: "tickets.json",  required: false }
];

const sectionPath = (section) => path.join(DATA_DIR, section.file);
const tmpPath = (section) => sectionPath(section) + ".tmp";
const serialize = (value) => JSON.stringify(value === undefined ? null : value, null, 2) + "\n";

// Exactly what is on disk for each section, so a save that would rewrite a
// file with the byte-for-byte same content doesn't bother. The sync and the
// health checks both run on a timer and both mostly find nothing new.
const lastWritten = new Map();

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------- reading ----------

/**
 * The board as the directory has it, or null if this is not a directory we
 * wrote (no required section yet) or not one we can trust (a section that
 * will not parse — see quarantine).
 */
function readSections() {
  const board = {};

  for (const section of SECTIONS) {
    const file = sectionPath(section);
    if (!fs.existsSync(file)) {
      // A required section absent means there is no board here yet, which is
      // the ordinary first-run path, not a fault.
      if (section.required) return null;
      continue;
    }

    let text;
    try {
      text = fs.readFileSync(file, "utf8");
      board[section.key] = JSON.parse(text);
    } catch (err) {
      quarantine(`${section.file} could not be read (${err.message})`);
      return null;
    }
    lastWritten.set(section.key, text);
  }

  if (!Array.isArray(board.users) || !Array.isArray(board.accounts) || !Array.isArray(board.servers)) {
    quarantine("users, accounts or servers is not a list");
    return null;
  }
  return board;
}

/**
 * Seeding over a board we could not read would throw away every claim on it
 * with nothing to show for it. Move the whole directory aside instead and
 * say where it went: one bad section does not tell us the others are wrong,
 * and all of them together are what somebody would recover by hand.
 */
function quarantine(reason) {
  lastWritten.clear();
  const kept = firstFreePath(DATA_DIR + ".unreadable");
  try {
    fs.renameSync(DATA_DIR, kept);
    console.warn(`\n  shared-data/ could not be read (${reason}).`);
    console.warn(`  Kept it as ${path.basename(kept)}/ and started from the seed board.\n`);
  } catch (err) {
    console.warn(`\n  shared-data/ could not be read (${reason}) and could not be moved aside.\n`);
  }
}

// Never overwrite an earlier casualty: the first failure is usually the one
// worth reading, and it is the one a second failure would land on.
function firstFreePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function readLegacyFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
    if (parsed.users && parsed.accounts && parsed.servers) return parsed;
    console.warn("\n  shared-state.json is missing users, accounts or servers — starting from the seed board.\n");
  } catch (err) {
    console.warn(`\n  shared-state.json could not be read (${err.message}) — starting from the seed board.\n`);
  }
  return null;
}

/**
 * Whatever we just read, brought up to the current shape and with the
 * derived keys blanked. migrateAppData() is the same function the browser
 * runs, so a board converted here and a board converted there cannot drift.
 */
function hydrate(board) {
  migrateAppData(board);
  JIRA_DERIVED_KEYS.forEach((key) => {
    board[key] = key === "lastJiraSyncAt" ? null : [];
  });
  return board;
}

/**
 * The board, from the directory if it is there, from the old single file if
 * that is all there is, and from the seed otherwise.
 */
function load() {
  ensureDir();

  const split = readSections();
  if (split) {
    const board = hydrate(split);
    // A board that needed converting has to be written back, or the next
    // boot converts it again — and every save until then compares against
    // the pre-conversion text.
    writeAllSync(board);
    return board;
  }

  if (fs.existsSync(LEGACY_FILE)) {
    const legacy = readLegacyFile();
    if (legacy) {
      const board = hydrate(legacy);
      writeAllSync(board);
      archiveLegacyFile();
      return board;
    }
  }

  const seeded = hydrate(buildDefaultAppData());
  writeAllSync(seeded);
  return seeded;
}

// Kept, not removed. It is a complete board and the only copy of one that
// git has never seen, so it stays until somebody decides otherwise.
function archiveLegacyFile() {
  const kept = firstFreePath(LEGACY_FILE + ".migrated");
  try {
    fs.renameSync(LEGACY_FILE, kept);
    console.log("");
    console.log("  ┌─ Split shared-state.json into shared-data/ ────────────────");
    SECTIONS.forEach((s) => console.log(`  │  ${s.file}`));
    console.log(`  │  the original is kept as ${path.basename(kept)}`);
    console.log("  └───────────────────────────────────────────────────────────");
  } catch (err) {
    console.warn(`\n  Wrote shared-data/ but could not archive shared-state.json (${err.message}).`);
    console.warn("  Move it aside by hand — while it is there it is only ignored, not read.\n");
  }
}

// ---------- writing ----------

/**
 * Where the board is read from when it is time to write it.
 *
 * routes/state.js replaces the whole board on POST /api/state, so this
 * has to be asked each time rather than handed the object once — a save
 * coalesced behind an in-flight one must write the board as it is by then,
 * not the one that triggered it.
 */
let readBoard = () => null;

function attach(getBoard) {
  readBoard = typeof getBoard === "function" ? getBoard : () => null;
}

// A key on the board that no section claims would be silently dropped on
// every save. Said once, on the first save that sees it, rather than on
// every one — the point is to be noticed while adding it.
const unclaimedWarned = new Set();

function warnUnclaimed(board) {
  const claimed = new Set(SECTIONS.map((s) => s.key).concat(JIRA_DERIVED_KEYS));
  Object.keys(board).forEach((key) => {
    if (claimed.has(key) || unclaimedWarned.has(key)) return;
    unclaimedWarned.add(key);
    console.warn(`  Board key "${key}" has no file in shared-data/ and is not being saved.`);
    console.warn("  Add it to SECTIONS in state-store.js, or to JIRA_DERIVED_KEYS if the sync owns it.");
  });
}

function pendingWrites(board) {
  const stored = withoutJiraDerived(board);
  const pending = [];
  SECTIONS.forEach((section) => {
    const text = serialize(stored[section.key]);
    if (lastWritten.get(section.key) !== text) pending.push({ section, text });
  });
  return pending;
}

// Used on the paths that must not return before the board is on disk: the
// first write of a freshly split, seeded or converted board.
function writeAllSync(board) {
  warnUnclaimed(board);
  ensureDir();
  pendingWrites(board).forEach(({ section, text }) => {
    fs.writeFileSync(tmpPath(section), text);
    fs.renameSync(tmpPath(section), sectionPath(section));
    lastWritten.set(section.key, text);
  });
}

/**
 * Writes the board, one section at a time and one pass at a time.
 *
 * Four things persist and they overlap freely — the Jira sync, the health
 * checks, a claim posted by a browser, and a settings change. Two plain
 * writeFile calls to one path interleave and leave JSON followed by the tail
 * of a longer write, which the next boot cannot parse. So each section is
 * written to its own temp file and renamed over the real one (a rename is
 * atomic: a reader sees the old file or the new one, never half of either),
 * and anything asked for while a pass is in flight is coalesced into one
 * more pass after it.
 *
 * What splitting the file costs: the renames are atomic individually but not
 * as a group, so a crash inside that window can leave one section new and
 * another old. The window is the few hundred microseconds between renames of
 * a file that is already written, and the worst reading of it — a ticket
 * naming a server that is no longer there — is a state the board already
 * renders (Model.assigneeRows counts such a claim towards its holder but
 * towards no environment). A torn board is legible, not corrupt.
 */
let writing = false;
let writeAgain = false;

function save() {
  if (writing) { writeAgain = true; return; }

  const board = readBoard();
  if (!board) return;
  warnUnclaimed(board);

  const pending = pendingWrites(board);
  if (!pending.length) return;

  writing = true;
  ensureDir();

  const done = () => {
    writing = false;
    if (writeAgain) { writeAgain = false; save(); }
  };

  Promise.all(pending.map(({ section, text }) => fs.promises.writeFile(tmpPath(section), text)))
    .then(() => Promise.all(pending.map(({ section }) => fs.promises.rename(tmpPath(section), sectionPath(section)))))
    .then(() => { pending.forEach(({ section, text }) => lastWritten.set(section.key, text)); })
    .catch(() => { /* the next save tries again; lastWritten is untouched */ })
    .then(done, done);
}

// For the boot banner: which sections are on disk and how big each is.
function describe() {
  return SECTIONS.map((section) => {
    const text = lastWritten.get(section.key);
    return { file: section.file, lines: text ? text.split("\n").length - 1 : 0 };
  });
}

module.exports = { DATA_DIR, SECTIONS, attach, load, save, describe };
