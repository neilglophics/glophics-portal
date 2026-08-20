/**
 * Every environment variable this process reads, resolved and validated once.
 *
 * Nothing else in the codebase touches `process.env`. That is the whole point:
 * a missing DATABASE_URL should fail at boot with a sentence a human can act
 * on, not as a null-pointer three layers deep on the first request.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const SECRET_KEY_FILE = path.join(CONFIG_DIR, "secret.key");
const ENV_FILE = path.join(CONFIG_DIR, ".env");

// Real environment variables always win: a container that sets DATABASE_URL
// must not be overridden by a file someone left in the checkout.
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.error(`[config] could not read ${ENV_FILE}: ${err.message}`);
  }
}

const problems = [];

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) problems.push(`${name} is not set.`);
  return value;
}

function optional(name, fallback) {
  const value = (process.env[name] || "").trim();
  return value || fallback;
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}, got "${raw}".`);
    return fallback;
  }
  return parsed;
}

function choice(name, allowed, fallback) {
  const value = optional(name, fallback);
  if (!allowed.includes(value)) {
    problems.push(`${name} must be one of ${allowed.join(" | ")}, got "${value}".`);
    return fallback;
  }
  return value;
}

const NODE_ENV = choice("NODE_ENV", ["development", "test", "production"], "development");
const isProduction = NODE_ENV === "production";

/**
 * The key that encrypts stored third-party credentials (currently the Jira API
 * token). In production it must be supplied — losing it silently would mean
 * every secret in the database becomes undecryptable garbage. In development,
 * generating one into a gitignored file is the difference between "clone and
 * run" and "read three paragraphs of setup".
 */
function resolveSecretKey() {
  const supplied = (process.env.APP_SECRET_KEY || "").trim();
  if (supplied) {
    let decoded;
    try {
      decoded = Buffer.from(supplied, "base64");
    } catch (err) {
      problems.push("APP_SECRET_KEY is not valid base64.");
      return null;
    }
    if (decoded.length !== 32) {
      problems.push(`APP_SECRET_KEY must decode to 32 bytes, got ${decoded.length}.`);
      return null;
    }
    return decoded;
  }
  if (isProduction) {
    problems.push(
      "APP_SECRET_KEY is not set. Generate one with:\n" +
      "    node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\""
    );
    return null;
  }
  try {
    if (fs.existsSync(SECRET_KEY_FILE)) {
      const decoded = Buffer.from(fs.readFileSync(SECRET_KEY_FILE, "utf8").trim(), "base64");
      if (decoded.length === 32) return decoded;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_KEY_FILE, generated.toString("base64") + "\n", { mode: 0o600 });
    return generated;
  } catch (err) {
    problems.push(`Could not read or create ${SECRET_KEY_FILE}: ${err.message}`);
    return null;
  }
}

function previousSecretKey() {
  const raw = (process.env.APP_SECRET_KEY_PREVIOUS || "").trim();
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    problems.push(`APP_SECRET_KEY_PREVIOUS must decode to 32 bytes, got ${decoded.length}.`);
    return null;
  }
  return decoded;
}

/**
 * DATABASE_URL as its parts. mysql2 accepts a connection string, but parsing it
 * here means a typo is reported at boot as "DATABASE_URL is missing a database
 * name" rather than as a driver error on the first query.
 */
function parseDatabaseUrl() {
  const raw = required("DATABASE_URL");
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    problems.push("DATABASE_URL is not a valid URL. Expected mysql://user:password@host:port/database");
    return null;
  }
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
    problems.push(`DATABASE_URL must start with mysql:// or mariadb://, got "${url.protocol}//".`);
    return null;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    problems.push("DATABASE_URL is missing a database name (the path after the host).");
    return null;
  }
  return {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProduction,
  port: integer("PORT", 6767, { min: 1, max: 65535 }),

  database: parseDatabaseUrl(),
  databasePoolMax: integer("DATABASE_POOL_MAX", 8, { min: 1, max: 100 }),

  secretKey: resolveSecretKey(),
  previousSecretKey: previousSecretKey(),

  // "auto" derives it from the connection; the explicit values are for
  // deployments whose TLS terminates somewhere this process cannot observe.
  cookieSecure: choice("COOKIE_SECURE", ["auto", "true", "false"], "auto"),
  appOrigin: optional("APP_ORIGIN", ""),

  sessionAbsoluteTtlMs: integer("SESSION_ABSOLUTE_TTL_HOURS", 168, { min: 1, max: 8760 }) * 3600_000,
  sessionIdleTtlMs: integer("SESSION_IDLE_TTL_HOURS", 12, { min: 1, max: 8760 }) * 3600_000,
  sessionMaxPerUser: integer("SESSION_MAX_PER_USER", 10, { min: 1, max: 100 }),

  // "auto" tightens the curve whenever the IP allowlist is left open, because
  // then the only thing between the sign-in form and the internet is this.
  throttleProfile: choice("AUTH_THROTTLE_PROFILE", ["auto", "strict", "standard"], "auto"),

  adminUsername: optional("ADMIN_USERNAME", "admin"),
  adminPassword: optional("ADMIN_PASSWORD", ""),

  jiraBaseUrl: optional("JIRA_BASE_URL", ""),
  jiraEmail: optional("JIRA_EMAIL", ""),
  jiraApiToken: optional("JIRA_API_TOKEN", ""),

  requestBodyLimitBytes: integer("REQUEST_BODY_LIMIT_BYTES", 1024 * 1024, { min: 1024 }),
  requestBodyTimeoutMs: integer("REQUEST_BODY_TIMEOUT_MS", 10_000, { min: 1000 })
});

function assertValid() {
  if (!problems.length) return;
  const lines = problems.map((p) => `  - ${p}`).join("\n");
  throw new Error(`Configuration is not usable:\n${lines}`);
}

module.exports = { config, assertValid, SECRET_KEY_FILE };
