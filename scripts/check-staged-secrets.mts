/**
 * Refuses a commit that would add a credential.  npm run check:secrets
 *
 * Wired to a pre-commit hook, because relying on remembering to look has now
 * failed twice in this repo: a live Neon connection string reached
 * .env.example and was pushed to two remotes, and a sample_env holding every
 * real value was staged by a blanket `git add -A`.
 *
 * The lesson is not "be more careful" — it is that a check which runs BESIDE the
 * commit is not a check. This one runs before it and exits non-zero.
 *
 * It reads the STAGED content, not the working tree, so it sees exactly what the
 * commit would contain.
 */

import { execFileSync } from "node:child_process";

interface Rule {
  label: string;
  pattern: RegExp;
}

/**
 * Shapes, not specific values — a list of known strings would go stale the
 * moment anything is rotated.
 */
const RULES: Rule[] = [
  { label: "Neon/Postgres password", pattern: /postgres(?:ql)?:\/\/[^\s:]+:[^\s@]{8,}@/i },
  { label: "Neon role password (npg_…)", pattern: /\bnpg_[A-Za-z0-9]{12,}\b/ },
  { label: "Vercel Blob token", pattern: /\bvercel_blob_rw_[A-Za-z0-9_]{20,}\b/ },
  { label: "Atlassian/Jira API token", pattern: /\bATATT[A-Za-z0-9._-]{20,}\b/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { label: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/** Files that are meant to hold real values and must never be committed at all. */
const FORBIDDEN_PATHS = [/(^|\/)\.env(\.|$)/, /(^|\/)sample_env$/, /(^|\/)sample\.env$/];

/** A template is expected to contain assignments; only a REAL-looking value is a
 *  problem there, which the shape rules above already catch. */
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

if (!staged.length) process.exit(0);

const problems: string[] = [];

for (const file of staged) {
  if (FORBIDDEN_PATHS.some((p) => p.test(file))) {
    problems.push(`${file}: this file holds real values and must not be committed`);
    continue;
  }

  let content: string;
  try {
    // The staged blob, not the file on disk.
    content = git(["show", `:${file}`]);
  } catch {
    continue; // binary, or deleted
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    problems.push(`${file}:${line}: looks like a ${rule.label}`);
  }
}

if (!problems.length) process.exit(0);

console.error("\n  COMMIT REFUSED — the staged changes look like they contain a credential:\n");
for (const problem of problems) console.error(`    ${problem}`);
console.error(`
  If this is a real secret:
      git restore --staged <file>      and keep it out of git
      add it to .gitignore if it is a file of real values

  If it is genuinely a placeholder the pattern misreads, either make the
  placeholder obviously fake, or bypass once with:
      git commit --no-verify
`);
process.exit(1);
