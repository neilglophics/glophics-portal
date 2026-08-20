import { revalidatePath } from "next/cache";
import { publishBoard } from "@/lib/realtime/server";
import type { BoardEvents } from "@/lib/realtime/events";

/**
 * "This changed — tell everyone." Both halves of that, in one call.
 *
 * There are two audiences and they need different things:
 *
 *   revalidatePath  invalidates the Next cache so THIS tab's next render is
 *                   fresh. Without it the acting user submits a change and sees
 *                   the old board.
 *   publishBoard    tells OTHER tabs, which then refresh themselves.
 *
 * They are always wanted together, so keeping them apart only created a way to
 * remember one and forget the other.
 *
 * Both are called AFTER the write has committed. A publish inside a transaction
 * that later rolls back would have every client render something the database
 * does not have.
 */

/** Pages whose content depends on claims or occupancy. */
const OCCUPANCY_PAGES = ["/dashboard", "/environments", "/tickets", "/my-tickets", "/in-use"];

/** Pages that depend on the shape of the board: accounts, environments, people. */
const CONFIG_PAGES = [...OCCUPANCY_PAGES, "/health", "/settings", "/users", "/not-tracked"];

function revalidateOccupancyPaths(serverId?: string): void {
  for (const path of OCCUPANCY_PAGES) revalidatePath(path);
  if (serverId) revalidatePath(`/environments/${serverId}`);
  else revalidatePath("/environments/[serverId]", "page");
}

function revalidateConfigPaths(): void {
  for (const path of CONFIG_PAGES) revalidatePath(path);
  revalidatePath("/environments/[serverId]", "page");
  // The shell shows account rollups and badge counts on every page.
  revalidatePath("/", "layout");
}

/**
 * A change to who holds what.
 *
 * `socketId` is the acting tab's Pusher socket, read from the request header, so
 * Pusher excludes it from the fan-out — it has already been revalidated here and
 * does not need an echo telling it to refresh again.
 */
export async function notifyOccupancy<E extends keyof BoardEvents>(
  event: E,
  payload: BoardEvents[E],
  options?: { serverId?: string; socketId?: string | null },
): Promise<void> {
  revalidateOccupancyPaths(options?.serverId);
  await publishBoard(event, payload, { socketId: options?.socketId ?? null });
}

/** A change to the shape of the board — accounts, environments, people, settings. */
export async function notifyConfig<E extends keyof BoardEvents>(
  event: E,
  payload: BoardEvents[E],
  options?: { socketId?: string | null },
): Promise<void> {
  revalidateConfigPaths();
  await publishBoard(event, payload, { socketId: options?.socketId ?? null });
}

/** A Jira sync pass finished. Touches occupancy AND the Not-tracked list. */
export async function notifyJiraSync(
  payload: BoardEvents["jira.synced"],
): Promise<void> {
  revalidateOccupancyPaths();
  revalidatePath("/not-tracked");
  revalidatePath("/", "layout");
  // No socketId: a cron pass has no acting tab to exclude.
  await publishBoard("jira.synced", payload);
}
