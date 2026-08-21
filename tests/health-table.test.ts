import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterRepoRows,
  isRepoSort,
  repoFilterCounts,
  sortRepoRows,
  type RepoRow,
} from "../lib/shared/view-model.ts";
import type { RepoHealth } from "../lib/types.ts";

/**
 * The Health table's filters and sort order.
 *
 * Both come out of the URL, which anyone can edit and any link can carry, so
 * these have to behave for inputs nobody would type on purpose as well as the
 * ones the chips produce.
 */

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(
  overrides: Partial<RepoRow> & { repo: string; health: RepoHealth },
): RepoRow {
  return {
    serverId: `srv-${overrides.repo}`,
    env: "ENV-1",
    accountId: "acct-a",
    accountName: "Account A",
    url: overrides.health === "unconfigured" ? null : "https://dev.example.com/",
    healthCheckedAt: overrides.health === "unconfigured" ? null : ago(60_000),
    claims: [],
    note: null,
    ...overrides,
  };
}

const ROWS: RepoRow[] = [
  row({ repo: "storefront", health: "offline", env: "MS-1", accountId: "ms", accountName: "Musticker", healthCheckedAt: ago(600_000) }),
  row({ repo: "backend", health: "online", env: "MS-1", accountId: "ms", accountName: "Musticker", healthCheckedAt: ago(60_000) }),
  row({ repo: "admin", health: "unconfigured", env: "MS-1", accountId: "ms", accountName: "Musticker" }),
  row({ repo: "storefront", health: "online", env: "ASP-1", accountId: "asp", accountName: "AllSticker", healthCheckedAt: ago(300_000) }),
  row({ repo: "backend", health: "offline", env: "ASP-1", accountId: "asp", accountName: "AllSticker", healthCheckedAt: ago(120_000) }),
];

const repos = (rows: RepoRow[]) => rows.map((r) => `${r.accountId}/${r.repo}`);

describe("filterRepoRows", () => {
  it("treats an absent filter and \"all\" as the same thing", () => {
    assert.equal(filterRepoRows(ROWS, {}).length, ROWS.length);
    assert.equal(filterRepoRows(ROWS, { health: "all", repo: "all", account: "all" }).length, ROWS.length);
  });

  it("narrows by health", () => {
    assert.deepEqual(repos(filterRepoRows(ROWS, { health: "offline" })), ["ms/storefront", "asp/backend"]);
  });

  it("narrows by repository name", () => {
    assert.deepEqual(repos(filterRepoRows(ROWS, { repo: "backend" })), ["ms/backend", "asp/backend"]);
  });

  it("narrows by account id, not by display name", () => {
    // The sidebar links accounts by id, and two clients can share a name.
    assert.deepEqual(repos(filterRepoRows(ROWS, { account: "asp" })), ["asp/storefront", "asp/backend"]);
    assert.deepEqual(filterRepoRows(ROWS, { account: "AllSticker" }), []);
  });

  it("combines filters", () => {
    assert.deepEqual(repos(filterRepoRows(ROWS, { health: "offline", account: "ms" })), ["ms/storefront"]);
  });

  it("returns nothing for a value that matches nothing, rather than everything", () => {
    // A hand-edited URL must not silently widen the view.
    assert.deepEqual(filterRepoRows(ROWS, { health: "banana" }), []);
  });
});

describe("repoFilterCounts", () => {
  it("counts each dimension against the OTHER filters, so a chip's number is what clicking it gives", () => {
    const counts = repoFilterCounts(ROWS, { account: "ms" });

    assert.equal(counts.health.offline, 1); // not 2 — the board has two, Musticker has one
    assert.equal(counts.health.online, 1);
    assert.equal(counts.health.unconfigured, 1);
    assert.equal(counts.totals.health, 3);

    // The account list itself is NOT narrowed by the account filter, or picking
    // one account would hide every other option.
    assert.deepEqual(
      counts.account.map((a) => `${a.id}:${a.count}`),
      ["asp:2", "ms:3"],
    );
  });

  it("narrows the account counts by the health filter", () => {
    const counts = repoFilterCounts(ROWS, { health: "offline" });
    assert.deepEqual(
      counts.account.map((a) => `${a.id}:${a.count}`),
      ["asp:1", "ms:1"],
    );
  });

  it("lists repository names alphabetically with their counts", () => {
    const counts = repoFilterCounts(ROWS, {});
    assert.deepEqual(
      counts.repo.map((r) => `${r.name}:${r.count}`),
      ["admin:1", "backend:2", "storefront:2"],
    );
  });
});

describe("sortRepoRows", () => {
  it("falls back to worst-health-first for an unknown or missing column", () => {
    // Offline first, then account name, then environment, then repo — so the
    // two offline rows lead, AllSticker ahead of Musticker.
    const expected = ["asp/backend", "ms/storefront", "ms/admin", "asp/storefront", "ms/backend"];
    assert.deepEqual(repos(sortRepoRows(ROWS, undefined, undefined)), expected);
    assert.deepEqual(repos(sortRepoRows(ROWS, "'; DROP TABLE", "asc")), expected);
  });

  it("sorts by account name, then falls back to the default order within it", () => {
    assert.deepEqual(repos(sortRepoRows(ROWS, "account", "asc")), [
      "asp/backend",
      "asp/storefront",
      "ms/storefront",
      "ms/admin",
      "ms/backend",
    ]);
  });

  it("reverses on desc", () => {
    const asc = repos(sortRepoRows(ROWS, "repo", "asc"));
    const desc = repos(sortRepoRows(ROWS, "repo", "desc"));
    assert.equal(asc[0], "ms/admin");
    assert.notEqual(asc[0], desc[0]);
  });

  it("puts the worst health first on the first click, not the alphabetical one", () => {
    // A health page exists to surface problems; "asc" means useful-first.
    assert.equal(sortRepoRows(ROWS, "health", "asc")[0]!.health, "offline");
    assert.equal(sortRepoRows(ROWS, "health", "desc")[0]!.health, "online");
  });

  it("sorts by check age, oldest first", () => {
    const sorted = sortRepoRows(ROWS, "checked", "asc");
    assert.deepEqual(repos(sorted).slice(0, 3), ["ms/storefront", "asp/storefront", "asp/backend"]);
  });

  it("keeps never-checked rows last in BOTH directions", () => {
    // "Never" is the absence of a timestamp, not an ancient one — and every
    // repository with no URL has it.
    const asc = sortRepoRows(ROWS, "checked", "asc");
    const desc = sortRepoRows(ROWS, "checked", "desc");
    assert.equal(asc.at(-1)!.healthCheckedAt, null);
    assert.equal(desc.at(-1)!.healthCheckedAt, null);
  });

  it("does not mutate the array it was given", () => {
    const before = repos(ROWS);
    sortRepoRows(ROWS, "repo", "desc");
    assert.deepEqual(repos(ROWS), before);
  });
});

describe("isRepoSort", () => {
  it("accepts the five real columns and nothing else", () => {
    for (const column of ["health", "repo", "env", "account", "checked"]) {
      assert.equal(isRepoSort(column), true);
    }
    assert.equal(isRepoSort("url"), false);
    assert.equal(isRepoSort(undefined), false);
  });
});
