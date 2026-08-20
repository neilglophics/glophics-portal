/**
 * IP allowlist — the outermost gate, ahead of the sign-in screen.
 *
 * Sign-in decides *who* may use the portal; this decides *from where*. A
 * stranger who never reaches the request handler can't guess at passwords,
 * fingerprint the app, or sit on /api/auth/login all day. Every request —
 * static files included — passes through allows() before anything else runs.
 *
 * Configure it with either (both are merged):
 *
 *   ALLOWED_IPS="203.0.113.7, 198.51.100.0/24, lan"   (env, comma/space separated)
 *   allowed-ips.json                                   (file, see the .example)
 *
 * An entry is a plain address (v4 or v6), a CIDR block, or one of the
 * aliases below. With no entries at all the gate stays open and index.js
 * prints a warning — an empty allowlist means "not configured yet", never
 * "let nobody in", so a missing env var can't lock everyone out of a
 * running deployment.
 *
 * Loopback is allowed by default whatever the list says: something on the
 * same machine can already reach the port, and refusing it only locks the
 * host out of its own portal. Set ALLOW_LOOPBACK=false if the box has
 * untrusted local users or SSH tunnels you don't control.
 *
 * IMPORTANT — behind a proxy (nginx, Cloudflare, ngrok, a PaaS router) the
 * socket peer is the proxy, so every request looks like one address. Set
 * TRUST_PROXY to the number of proxies in front of this server to read the
 * client out of X-Forwarded-For instead. It stays off by default because
 * that header is client-writable: trusting it with no proxy in front lets
 * anyone claim any address and walk straight through this gate.
 */

const fs = require("fs");
const path = require("path");

const { CONFIG_DIR } = require("./paths.js");

const CONFIG_FILE = path.join(CONFIG_DIR, "allowed-ips.json");

// Shorthands, so nobody has to remember which /8 the private ranges are.
const ALIASES = {
  loopback: ["127.0.0.0/8", "::1/128"],
  lan: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"],
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"]
};

const OPEN_TOKENS = new Set(["*", "any", "all", "0.0.0.0/0"]);

// ---------- address parsing ----------
// Addresses are compared as bytes, not strings: "203.0.113.5",
// "::ffff:203.0.113.5" and "::ffff:cb00:7105" are one client arriving over
// a dual-stack socket, and a string compare would call them three.

function parseIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(text) {
  if (!text.includes(":")) return null;
  let str = text;

  // A trailing dotted quad (::ffff:203.0.113.5) is the same 32 bits as two
  // hex groups — rewrite it so the group loop below only ever sees hex.
  const embedded = str.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const v4 = parseIpv4(embedded[1]);
    if (!v4) return null;
    str = str.slice(0, -embedded[1].length) +
      ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = tail === null
    ? head
    : head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail);
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isV4Mapped(bytes) {
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

// Returns 4 bytes for v4 (and v4-mapped v6), 16 for real v6, null for junk.
function parseIp(text) {
  const cleaned = String(text || "").trim().replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  if (!cleaned) return null;
  const v4 = parseIpv4(cleaned);
  if (v4) return v4;
  const v6 = parseIpv6(cleaned);
  if (!v6) return null;
  return isV4Mapped(v6) ? v6.slice(12) : v6;
}

function formatIp(bytes) {
  if (!bytes) return "unknown";
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(":");
}

// "203.0.113.0/24" becomes a rule; a bare address is its own /32 or /128.
function parseEntry(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text || text.startsWith("#")) return [];
  if (ALIASES[text]) return ALIASES[text].flatMap(parseEntry);

  const slash = text.indexOf("/");
  const addr = slash < 0 ? text : text.slice(0, slash);
  const bytes = parseIp(addr);
  if (!bytes) return [];

  let bits = bytes.length * 8;
  if (slash >= 0) {
    const n = Number(text.slice(slash + 1));
    if (!Number.isInteger(n) || n < 0 || n > bytes.length * 8) return [];
    bits = n;
  }
  return [{ bytes, bits, label: String(raw).trim() }];
}

function inRule(ip, rule) {
  if (ip.length !== rule.bytes.length) return false; // a v4 client never matches a v6 rule
  const whole = rule.bits >> 3;
  for (let i = 0; i < whole; i += 1) if (ip[i] !== rule.bytes[i]) return false;
  const spare = rule.bits & 7;
  if (spare) {
    const mask = (0xff << (8 - spare)) & 0xff;
    if ((ip[whole] & mask) !== (rule.bytes[whole] & mask)) return false;
  }
  return true;
}

// ---------- configuration ----------

const LOOPBACK_RULES = ALIASES.loopback.flatMap(parseEntry);

let config = { rules: [], open: true, trustProxy: 0, allowLoopback: true, invalid: [], sources: [] };

function readConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.warn(`[ip-allowlist] allowed-ips.json is not valid JSON (${err.message}) — ignoring it.`);
    return null;
  }
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,\s]+/);
  return [];
}

function loadConfig() {
  const file = readConfigFile() || {};
  const sources = [];

  const entries = [];
  if (process.env.ALLOWED_IPS) {
    entries.push(...toList(process.env.ALLOWED_IPS));
    sources.push("ALLOWED_IPS");
  }
  if (file.allowed !== undefined) {
    entries.push(...toList(file.allowed));
    sources.push("allowed-ips.json");
  }

  const wanted = entries.map((entry) => String(entry).trim()).filter(Boolean);
  const open = wanted.some((entry) => OPEN_TOKENS.has(entry.toLowerCase()));
  const rules = [];
  const invalid = [];
  for (const entry of wanted) {
    if (OPEN_TOKENS.has(entry.toLowerCase())) continue;
    const parsed = parseEntry(entry);
    if (parsed.length) rules.push(...parsed);
    else invalid.push(entry);
  }

  // TRUST_PROXY=true means one proxy; a number means that many hops.
  const rawTrust = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : file.trustProxy;
  let trustProxy = 0;
  if (rawTrust === true || String(rawTrust).toLowerCase() === "true") trustProxy = 1;
  else if (Number.isInteger(Number(rawTrust)) && Number(rawTrust) > 0) trustProxy = Number(rawTrust);

  const allowLoopback = process.env.ALLOW_LOOPBACK !== undefined
    ? String(process.env.ALLOW_LOOPBACK).toLowerCase() !== "false"
    : file.allowLoopback !== false;

  config = { rules, open: open || rules.length === 0, trustProxy, allowLoopback, invalid, sources };
  if (invalid.length) {
    console.warn(`[ip-allowlist] ignoring ${invalid.length} entr${invalid.length === 1 ? "y" : "ies"} that aren't an address or CIDR block: ${invalid.join(", ")}`);
  }
  return config;
}

loadConfig();

// One line per address rather than one per request: a scanner hitting the
// port shouldn't be able to bury the interesting logs.
const blockedSeen = new Set();

// Editing allowed-ips.json takes effect without a restart — fat-fingering
// an address shouldn't need shell access to the box to undo.
fs.watchFile(CONFIG_FILE, { interval: 2000, persistent: false }, () => {
  loadConfig();
  blockedSeen.clear();
  console.log(`[ip-allowlist] reloaded allowed-ips.json — ${describe()}`);
});

// ---------- the gate ----------

// Which address to judge a request by. Without TRUST_PROXY that is the
// socket peer, the one thing a client cannot lie about.
function clientIp(req) {
  const socketIp = parseIp(req.socket && req.socket.remoteAddress);
  if (!config.trustProxy) return socketIp;

  // X-Forwarded-For reads client, proxy1, …, proxyN-1 — the peer is proxyN
  // and never appears in it. So with N trusted proxies the client sits N
  // from the right; counting from the left instead would trust whatever a
  // caller prepended to the header themselves.
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  const index = chain.length - config.trustProxy;
  return parseIp(chain[index >= 0 ? index : 0]) || socketIp;
}

function allowsIp(ip) {
  if (config.open) return true;
  if (!ip) return false; // no readable address, and a list is in force → refuse
  if (config.allowLoopback && LOOPBACK_RULES.some((rule) => inRule(ip, rule))) return true;
  return config.rules.some((rule) => inRule(ip, rule));
}

function noteBlocked(ip, req) {
  const key = formatIp(ip);
  if (blockedSeen.has(key)) return;
  if (blockedSeen.size > 500) blockedSeen.clear();
  blockedSeen.add(key);
  console.warn(`[ip-allowlist] blocked ${key} (${req.method} ${req.url}) — add it to ALLOWED_IPS or allowed-ips.json to let it in`);
}

// The only call index.js makes. True = carry on; false = it has been
// logged already and the caller should answer 403.
function allows(req) {
  const ip = clientIp(req);
  if (allowsIp(ip)) return true;
  noteBlocked(ip, req);
  return false;
}

function isOpen() {
  return config.open;
}

function describe() {
  if (config.open) return "open to every address";
  const ranges = config.rules.map((rule) => rule.label).join(", ");
  const parts = [`${config.rules.length} allowed ${config.rules.length === 1 ? "range" : "ranges"}: ${ranges}`];
  if (config.allowLoopback) parts.push("plus loopback");
  if (config.trustProxy) parts.push(`client read from X-Forwarded-For, ${config.trustProxy} hop${config.trustProxy === 1 ? "" : "s"} back`);
  return parts.join("; ");
}

module.exports = {
  allows,
  clientIp,
  isOpen,
  describe,
  formatIp,
  // exported so a change here can be checked without starting the server
  parseIp,
  parseEntry,
  inRule,
  reload: loadConfig
};
