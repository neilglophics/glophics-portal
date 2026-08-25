/**
 * The shapes paging a table passes around.
 *
 * Kept apart from lib/shared/pagination.ts, which computes them, and from
 * components/ui/Pagination.tsx, which draws them: the helper and the component
 * are used independently — a page can slice rows without rendering a pager, and
 * a pager can be handed numbers from somewhere else — so neither should have to
 * import the other to name what it is holding.
 *
 * These are NOT domain types and deliberately do not live in lib/types.ts. That
 * module is the row shapes of docs/02-DATA-MODEL.md in camelCase; nothing here
 * corresponds to anything in the database.
 */

/**
 * One entry in the run of page controls: a page to link to, or the ellipsis
 * standing in for a stretch of pages that were skipped.
 *
 * A union rather than an interface because "gap" is not an object — it carries
 * no data beyond its own presence, which is the whole point of it.
 */
export type PageLink = number | "gap";

/**
 * Where a page sits in a list, with no reference to what the list holds.
 *
 * Split out from Paged so the pager can require exactly this and no rows: it
 * counts them, it never touches one. That is what lets a page write
 * `<Pagination {...paged} … />` without the component becoming generic.
 */
export interface PagePosition {
  /** 1-based and clamped — never outside [1, pageCount]. */
  page: number;
  /** At least 1, so "Page 1 of 1" is sayable for an empty list. */
  pageCount: number;
  total: number;
  /** 1-based index of the first row on screen, and of the last. Both 0 when the
   *  list is empty, so "Showing 0–0 of 0" never claims a row that isn't there. */
  from: number;
  to: number;
}

/** A page's worth of a longer list, plus where it sits within it. */
export interface Paged<T> extends PagePosition {
  items: T[];
}

/** What components/ui/Pagination.tsx needs to draw itself. */
export interface PaginationProps extends PagePosition {
  /** The caller owns the URL shape — the component never builds a route. */
  href: (page: number) => string;
  /** Plural noun for the count line: "tickets". */
  label: string;
  /** The run of links to draw, from pageWindow(). */
  window: PageLink[];
}

/** One end of the pager — the prev/next chevron. */
export interface PaginationStepProps {
  href: string;
  /** The accessible name. An arrow glyph has none of its own. */
  label: string;
  /** Point it backwards. */
  back?: boolean;
  /** True at the first or last page, where it renders as dead rather than as a
   *  link that goes nowhere. */
  disabled: boolean;
}
