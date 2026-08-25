/**
 * Page a long list down to a screenful. Ported from the legacy dashboard's
 * `paged()` helper in public/js/ui/page-dashboard.js, which did the same job for
 * its two tables with view state kept on the page object.
 *
 * Pure functions over an array the caller already loaded, so these run on the
 * server inside a Server Component and need no database access of their own —
 * the same rule lib/shared/view-model.ts follows.
 *
 * ── Why an index, when chat deliberately refuses one ──
 *
 * lib/db/queries/chat.ts pages by keyset (`WHERE id < cursor`) and its header
 * says why in as many words: a message arriving mid-scroll shifts an OFFSET
 * boundary, so a row appears twice or not at all. That reasoning is about a
 * live-appending stream being read from one end.
 *
 * A ticket list is not that. It is re-read whole on every request, ordered in
 * JS by "frees soonest first", and has no stable cursor to key on — the sort key
 * is a countdown that changes every minute. An index is the honest model here:
 * page 3 means "the third screenful of what the board looks like right now".
 *
 * The cost of that honesty is a page number that can go stale, which is what
 * paginate() clamps.
 */

import type { PageLink, PagePosition, Paged } from "./pagination-types";

/** Ten rows a page across the ticket tables. */
export const TICKETS_PER_PAGE = 10;

/**
 * Parse `?page=`.
 *
 * Anything that is not a whole number >= 1 falls back to page 1 rather than
 * throwing: the value comes from a URL anyone can edit, and the same rule
 * already governs the sort column on the health page.
 */
export function pageNumber(value: string | undefined): number {
  if (!value) return 1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Where a page sits in a list of `total` rows — WITHOUT the rows.
 *
 * This half is separate because the rows may not be in memory to slice. A
 * database-paged list knows its total from a count() and needs `from` to build
 * the OFFSET, so it computes the position first and fetches second; an
 * in-memory list does both at once in paginate() below. Both go through here,
 * so the clamping rules cannot drift apart.
 *
 * The page is CLAMPED at both ends. A number kept from before a claim freed —
 * a bookmark, a back button, a hand-edited URL — would otherwise land past the
 * end, and components/ui/Table.tsx short-circuits to <Empty> whenever it has no
 * rows. So an unclamped page 99 would tell somebody looking at a full board that
 * the last sync found nothing. Clamping turns that into the last real page.
 */
export function pagePosition(
  total: number,
  page: number,
  perPage: number = TICKETS_PER_PAGE,
): PagePosition {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);

  const start = (current - 1) * perPage;
  const size = Math.max(0, Math.min(perPage, total - start));

  return {
    page: current,
    pageCount,
    total,
    from: size ? start + 1 : 0,
    to: start + size,
  };
}

/** A page's worth of a list already in memory. */
export function paginate<T>(items: T[], page: number, perPage: number = TICKETS_PER_PAGE): Paged<T> {
  const position = pagePosition(items.length, page, perPage);
  const start = (position.page - 1) * perPage;

  return { ...position, items: items.slice(start, start + perPage) };
}

/**
 * The run of page links to render: `[1, "gap", 5, 6, 7, "gap", 20]`.
 *
 * First and last are always present — they are the two destinations people
 * actually aim for — with a window of `span` pages centred on the current one.
 *
 * A "gap" is only emitted where MORE THAN ONE page is skipped. An ellipsis
 * standing in for a single page is a lie that costs a click: it is both wider
 * than the number it hides and not clickable.
 */
export function pageWindow(page: number, pageCount: number, span: number = 5): PageLink[] {
  if (pageCount <= 1) return pageCount === 1 ? [1] : [];

  const half = Math.floor(span / 2);
  // Shift the window back at the end of the list so it keeps its full width
  // instead of shrinking to two entries on the last page.
  let start = Math.max(1, Math.min(page - half, pageCount - span + 1));
  const end = Math.min(pageCount, start + span - 1);
  start = Math.max(1, Math.min(start, end));

  const out: PageLink[] = [];

  if (start > 1) {
    out.push(1);
    // start - 1 is the only page between 1 and the window: render it, not a gap.
    if (start > 3) out.push("gap");
    else if (start === 3) out.push(2);
  }

  for (let n = start; n <= end; n += 1) out.push(n);

  if (end < pageCount) {
    if (end < pageCount - 2) out.push("gap");
    else if (end === pageCount - 2) out.push(pageCount - 1);
    out.push(pageCount);
  }

  return out;
}
