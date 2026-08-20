/**
 * Re-exported so lib/shared/nav.ts carries no dependency on the wider type
 * modules — the nav is imported by a client component, and keeping its imports
 * narrow keeps that bundle small.
 */
export type { Capability } from "@/lib/types";
export type { IconName } from "@/lib/shared/tokens";
