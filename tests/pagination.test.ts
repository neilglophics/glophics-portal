import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TICKETS_PER_PAGE,
  pageNumber,
  pageWindow,
  paginate,
} from "../lib/shared/pagination.ts";

/**
 * Paging the ticket tables.
 *
 * The page number comes out of the URL, which anyone can edit and any bookmark
 * can carry, and the list it indexes into shrinks whenever a claim frees up. So
 * the cases that matter here are the ones nobody types on purpose: a page past
 * the end, a page below the start, and a page that is not a number at all.
 */

const list = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("pageNumber", () => {
  it("falls back to page 1 for anything that is not a whole number >= 1", () => {
    for (const value of [undefined, "", "abc", "0", "-3", "2.5", "1e3000", "Infinity", " "]) {
      assert.equal(pageNumber(value), 1, `expected ${JSON.stringify(value)} to fall back`);
    }
  });

  it("takes a real page number", () => {
    assert.equal(pageNumber("3"), 3);
    assert.equal(pageNumber("117"), 117);
  });
});

describe("paginate", () => {
  it("defaults to ten rows a page", () => {
    assert.equal(TICKETS_PER_PAGE, 10);
    assert.equal(paginate(list(118), 1).items.length, 10);
  });

  it("reports where in the list you are, 1-based", () => {
    const p = paginate(list(118), 3);
    assert.deepEqual(p.items, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    assert.equal(p.from, 21);
    assert.equal(p.to, 30);
    assert.equal(p.total, 118);
    assert.equal(p.pageCount, 12);
  });

  it("does not invent a page for an exact multiple", () => {
    // 20 rows at 10 a page is two pages. An off-by-one here shows an empty
    // third page that the pager still links to.
    assert.equal(paginate(list(20), 1).pageCount, 2);
    assert.equal(paginate(list(10), 1).pageCount, 1);
  });

  it("counts the short last page correctly", () => {
    const p = paginate(list(118), 12);
    assert.deepEqual(p.items, [111, 112, 113, 114, 115, 116, 117, 118]);
    assert.equal(p.from, 111);
    assert.equal(p.to, 118);
  });

  it("clamps a stale page to the last real one, never past the end", () => {
    // Table renders <Empty> when it has no rows, so an unclamped page here
    // would tell somebody looking at a full board that there are no tickets.
    const p = paginate(list(118), 9999);
    assert.equal(p.page, 12);
    assert.equal(p.items.length, 8);
    assert.notEqual(p.items.length, 0);
  });

  it("clamps below the start too", () => {
    for (const page of [0, -1, Number.NaN]) {
      const p = paginate(list(118), page);
      assert.equal(p.page, 1);
      assert.equal(p.from, 1);
    }
  });

  it("survives an empty list without claiming a row", () => {
    const p = paginate([], 4);
    assert.deepEqual(p.items, []);
    assert.equal(p.page, 1);
    assert.equal(p.pageCount, 1, "pageCount is at least 1 so 'Page 1 of 1' is sayable");
    assert.equal(p.total, 0);
    assert.equal(p.from, 0);
    assert.equal(p.to, 0);
  });

  it("honours a different page size", () => {
    const p = paginate(list(7), 2, 3);
    assert.deepEqual(p.items, [4, 5, 6]);
    assert.equal(p.pageCount, 3);
  });
});

describe("pageWindow", () => {
  const numbers = (w: (number | "gap")[]) => w.filter((e): e is number => e !== "gap");

  it("draws every page while they still fit", () => {
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(2, 4), [1, 2, 3, 4]);
    assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
  });

  it("draws nothing when there are no pages at all", () => {
    assert.deepEqual(pageWindow(1, 0), []);
  });

  it("keeps the first and last page reachable in one click", () => {
    for (const page of [1, 4, 6, 9, 12]) {
      const w = pageWindow(page, 12);
      assert.ok(w.includes(1), `page ${page}: first page missing`);
      assert.ok(w.includes(12), `page ${page}: last page missing`);
      assert.ok(w.includes(page), `page ${page}: current page missing`);
    }
  });

  it("never repeats a page", () => {
    for (let pageCount = 1; pageCount <= 30; pageCount += 1) {
      for (let page = 1; page <= pageCount; page += 1) {
        const ns = numbers(pageWindow(page, pageCount));
        assert.equal(new Set(ns).size, ns.length, `duplicate at ${page}/${pageCount}`);
        assert.deepEqual([...ns].sort((a, b) => a - b), ns, `out of order at ${page}/${pageCount}`);
        for (const n of ns) assert.ok(n >= 1 && n <= pageCount, `page ${n} does not exist`);
      }
    }
  });

  it("never hides a single page behind an ellipsis", () => {
    // "…" is wider than the number it would replace and cannot be clicked, so
    // a gap only earns its place when it stands for more than one page.
    for (let pageCount = 1; pageCount <= 30; pageCount += 1) {
      for (let page = 1; page <= pageCount; page += 1) {
        const w = pageWindow(page, pageCount);
        w.forEach((entry, i) => {
          if (entry !== "gap") return;
          const before = w[i - 1];
          const after = w[i + 1];
          assert.equal(typeof before, "number", `leading gap at ${page}/${pageCount}`);
          assert.equal(typeof after, "number", `trailing gap at ${page}/${pageCount}`);
          assert.ok(
            (after as number) - (before as number) > 2,
            `gap hides only one page at ${page}/${pageCount}: ${JSON.stringify(w)}`,
          );
        });
      }
    }
  });

  it("keeps the window full width at either end of a long list", () => {
    // Without the shift, page 12 of 12 would draw "1 … 11 12" — a two-entry
    // pager on the page people reach most often after "last".
    assert.deepEqual(pageWindow(12, 12), [1, "gap", 8, 9, 10, 11, 12]);
    assert.deepEqual(pageWindow(1, 12), [1, 2, 3, 4, 5, "gap", 12]);
    assert.deepEqual(pageWindow(6, 12), [1, "gap", 4, 5, 6, 7, 8, "gap", 12]);
  });
});
