/**
 * Minimal .env loader for the CLI scripts.
 *
 * Next loads .env.local on its own; standalone scripts run under plain node and
 * do not. Rather than add a dependency for twelve lines, this parses the file
 * directly — and deliberately does NOT overwrite a variable that is already set,
 * so `DATABASE_URL=… npm run db:migrate` still wins over the file.
 */

import fs from "node:fs";
import path from "node:path";

const FILES = [".env.local", ".env"];

export function loadEnv(root = process.cwd()): void {
  for (const name of FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;

    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq < 0) continue;

      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue;

      let value = line.slice(eq + 1).trim();
      // Strip one layer of matching quotes; connection strings often carry them.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

/** Fail loudly and usefully rather than letting a driver throw something opaque. */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.${hint ? ` ${hint}` : ""}`);
  }
  return value;
}
