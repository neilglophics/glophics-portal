import { revalidatePath } from "next/cache";

/**
 * Which cached pages a mutation invalidates.
 *
 * Every page reads the board in a Server Component, so a write has to say what
 * it made stale. Listed centrally rather than per route, because the honest
 * answer for most config changes is "nearly everything" — an account rename
 * shows up on six pages — and enumerating that per handler is how one gets
 * forgotten.
 *
 * Phase 7 replaces this with granular Pusher events, which will let *other*
 * viewers see the change too. Until then this only refreshes the tab that made
 * it; see docs/03-REALTIME-SPEC.md §4.
 */

/** Pages whose content depends on claims or occupancy. */
const OCCUPANCY_PAGES = ["/dashboard", "/environments", "/tickets", "/my-tickets", "/in-use"];

/** Pages that depend on the shape of the board: accounts, environments, people. */
const CONFIG_PAGES = [...OCCUPANCY_PAGES, "/health", "/settings", "/users", "/not-tracked"];

export function revalidateOccupancy(serverId?: string): void {
  for (const path of OCCUPANCY_PAGES) revalidatePath(path);
  if (serverId) revalidatePath(`/environments/${serverId}`);
  else revalidatePath("/environments/[serverId]", "page");
}

export function revalidateConfig(): void {
  for (const path of CONFIG_PAGES) revalidatePath(path);
  // The detail route is dynamic, so it is invalidated by its route pattern
  // rather than one path at a time.
  revalidatePath("/environments/[serverId]", "page");
  // The shell shows account rollups and badge counts on every page.
  revalidatePath("/", "layout");
}
