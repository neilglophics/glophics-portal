/**
 * Which addresses may reach the app at all. Ported from server/ip-allowlist.js.
 *
 * Runs in **Edge middleware**, ahead of routing, sessions and even the sign-in
 * screen — so a non-allowlisted address gets one answer for every path and never
 * learns there is a portal here. That ordering is the outermost layer of the
 * security model; see docs/00-CONTEXT-CURRENT-SYSTEM.md.
 *
 * Pure TypeScript: no node:net, no fs. Two behaviours change from the legacy
 * version, both forced by the platform (docs/06-OPEN-QUESTIONS.md Q3):
 *
 *   1. The list comes from ALLOWED_IPS only. There is no writable disk, so
 *      config/allowed-ips.json is gone — and with it the "edit the file, no
 *      restart" escape hatch. Changing the list is now an env update.
 *
 *   2. An empty list FAILS CLOSED in production. The legacy app failed open
 *      deliberately, so a missing env var could not lock a team out of a portal
 *      on their own LAN. On a public URL that same rule silently exposes
 *      everything, which is the worse of the two failures. Development still
 *      fails open, because locking yourself out of localhost is pointless.
 */

export type IpRule = { bytes: Uint8Array; bits: number };

const LOOPBACK = ["127.0.0.0/8", "::1/128"];
const PRIVATE = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
];

// ---------- parsing ----------

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i]!;
    // Reject "01" and "1e2": a leading zero or stray character means this is not
    // an address, and guessing at it is how a rule ends up matching the wrong host.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  let head = text;
  let tail = "";

  const double = text.indexOf("::");
  if (double >= 0) {
    if (text.indexOf("::", double + 1) >= 0) return null; // only one "::" allowed
    head = text.slice(0, double);
    tail = text.slice(double + 2);
  }

  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];

  // A trailing IPv4 form, e.g. ::ffff:192.168.0.1
  const last = tailGroups.length ? tailGroups[tailGroups.length - 1]! : headGroups[headGroups.length - 1];
  let v4: Uint8Array | null = null;
  if (last && last.includes(".")) {
    v4 = parseIpv4(last);
    if (!v4) return null;
    if (tailGroups.length) tailGroups.pop();
    else headGroups.pop();
  }

  const groupCount = headGroups.length + tailGroups.length + (v4 ? 2 : 0);
  if (double < 0 ? groupCount !== 8 : groupCount > 7) return null;

  const bytes = new Uint8Array(16);
  let at = 0;

  const write = (group: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    const n = parseInt(group, 16);
    bytes[at++] = (n >> 8) & 0xff;
    bytes[at++] = n & 0xff;
    return true;
  };

  for (const g of headGroups) if (!write(g)) return null;

  // The "::" run is already zero from the Uint8Array initialiser; just skip it.
  at = 16 - (tailGroups.length * 2 + (v4 ? 4 : 0));

  for (const g of tailGroups) if (!write(g)) return null;
  if (v4) bytes.set(v4, 12);

  return bytes;
}

/**
 * An address as bytes. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped to plain
 * IPv4, so a v4 rule matches a client that arrived over a v6 socket — which is
 * how most proxies present it, and a trap if you skip this.
 */
export function parseIp(value: string | null | undefined): Uint8Array | null {
  let text = String(value ?? "").trim();
  if (!text) return null;

  // Strip a zone index (fe80::1%eth0) and brackets ([::1]:443).
  const pct = text.indexOf("%");
  if (pct >= 0) text = text.slice(0, pct);
  if (text.startsWith("[")) text = text.slice(1, text.indexOf("]") >= 0 ? text.indexOf("]") : undefined);

  if (text.includes(":")) {
    const v6 = parseIpv6(text);
    if (!v6) return null;
    const isMapped =
      v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    return isMapped ? v6.slice(12) : v6;
  }
  return parseIpv4(text);
}

function parseRule(entry: string): IpRule | null {
  const text = entry.trim();
  if (!text) return null;

  const slash = text.lastIndexOf("/");
  const addressText = slash >= 0 ? text.slice(0, slash) : text;
  const bytes = parseIp(addressText);
  if (!bytes) return null;

  const maxBits = bytes.length * 8;
  if (slash < 0) return { bytes, bits: maxBits };

  const bits = Number(text.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
  return { bytes, bits };
}

function expand(entry: string): string[] {
  const key = entry.trim().toLowerCase();
  if (key === "loopback") return LOOPBACK;
  if (key === "lan" || key === "private") return PRIVATE;
  return [entry];
}

export interface Allowlist {
  rules: IpRule[];
  invalid: string[];
  /** No rules configured. */
  open: boolean;
  allowLoopback: boolean;
}

export function parseAllowlist(
  raw: string | undefined = process.env.ALLOWED_IPS,
  allowLoopbackRaw: string | undefined = process.env.ALLOW_LOOPBACK,
): Allowlist {
  const entries = String(raw ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .flatMap(expand);

  const rules: IpRule[] = [];
  const invalid: string[] = [];

  for (const entry of entries) {
    const rule = parseRule(entry);
    if (rule) rules.push(rule);
    else invalid.push(entry);
  }

  return {
    rules,
    invalid,
    open: rules.length === 0,
    allowLoopback: String(allowLoopbackRaw ?? "").toLowerCase() !== "false",
  };
}

// ---------- matching ----------

function inRule(ip: Uint8Array, rule: IpRule): boolean {
  // A v4 address never matches a v6 rule, or vice versa.
  if (ip.length !== rule.bytes.length) return false;

  const wholeBytes = rule.bits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (ip[i] !== rule.bytes[i]) return false;
  }

  const remainder = rule.bits & 7;
  if (remainder === 0) return true;

  const mask = 0xff << (8 - remainder);
  return (ip[wholeBytes]! & mask) === (rule.bytes[wholeBytes]! & mask);
}

const LOOPBACK_RULES = LOOPBACK.map(parseRule).filter((r): r is IpRule => !!r);

/**
 * Whether this address may proceed.
 *
 * `failClosedWhenUnset` inverts the legacy fail-open default. Callers pass
 * `true` in production: see the note at the top of this file.
 */
export function allowsIp(
  ipText: string | null | undefined,
  list: Allowlist,
  failClosedWhenUnset: boolean,
): boolean {
  if (list.open) return !failClosedWhenUnset;

  const ip = parseIp(ipText);
  // No readable address and a list is in force → refuse.
  if (!ip) return false;

  if (list.allowLoopback && LOOPBACK_RULES.some((rule) => inRule(ip, rule))) return true;
  return list.rules.some((rule) => inRule(ip, rule));
}

/**
 * The client address, per the platform.
 *
 * This is the one place the legacy reasoning inverts. There, TRUST_PROXY was off
 * by default because X-Forwarded-For is client-writable and trusting it with no
 * proxy in front lets anyone claim any address. On Vercel there is *always*
 * exactly one trusted hop in front, and the socket peer is always the edge — so
 * the forwarded header is the only real answer, and Vercel overwrites the
 * left-most entry it sets rather than appending to what a client sent.
 *
 * `x-real-ip` is preferred because it is a single value the platform sets.
 * x-forwarded-for is the fallback, and we take its **last** entry, not its first.
 * The header reads `client, proxy1, …, proxyN-1`; with exactly one trusted hop
 * the client sits last. That is also the safe reading if the platform *appends*
 * to a header the caller already sent — a forged `1.2.3.4` would land first and
 * the real address last. If the platform instead overwrites the header (Vercel
 * documents that it does — *verify*), first and last are the same value and the
 * choice is moot. Reading the first entry is wrong in one case and right in
 * none, so it is never the right default.
 */
export function clientIp(headers: Headers): string | null {
  const real = headers.get("x-real-ip");
  if (real) return real.trim();

  const chain = headers.get("x-forwarded-for");
  if (!chain) return null;

  const parts = chain.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}
