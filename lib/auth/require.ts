/**
 * THE server-side authorization boundary.
 *
 * Replaces server/access.js. Every route handler and every protected Server
 * Component calls `requireUser()`. Middleware does NOT do this job — it runs on
 * the Edge runtime, cannot reach node:crypto, and only checks that a session
 * cookie is present at all.
 *
 * The rule from the legacy codebase still holds and is worth repeating: the UI
 * hides what you cannot use, but **hiding is courtesy and this is the boundary**.
 * Never add a capability check that exists only in a component.
 */

import { roleCan, roleLabel } from "@/lib/shared/roles";
import { getCurrentUser } from "./session";
import type { AuthUser, Capability } from "@/lib/types";

/** Thrown by requireUser(); turned into a JSON response by `withApi`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The signed-in user, or a 401. Pass a capability to require it too.
 *
 *   const user = await requireUser();            // any session
 *   const user = await requireUser("configure"); // and this capability
 */
export async function requireUser(capability?: Capability): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new HttpError(401, "Sign in to continue.");
  }
  if (capability && !roleCan(user.role, capability)) {
    throw new HttpError(403, `Your role (${roleLabel(user.role)}) can't do that.`, {
      needs: capability,
    });
  }
  return user;
}

/** For Server Components that render differently rather than refusing. */
export async function currentUserOrNull(): Promise<AuthUser | null> {
  return getCurrentUser();
}

export function can(user: AuthUser | null, capability: Capability): boolean {
  return !!user && roleCan(user.role, capability);
}

// ---------- route handler plumbing ----------

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response>;

/**
 * Wraps a route handler so a thrown HttpError becomes the right JSON response
 * and anything else becomes a 500 without leaking a stack trace to the client.
 *
 * Every route in app/api should be wrapped, so no handler has to remember to
 * catch — the legacy app hand-rolled this per route and the shapes drifted.
 */
export function withApi<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ ok: false, error: err.message, ...err.extra }, { status: err.status });
      }
      // Log the real thing server-side; tell the client nothing about it.
      console.error("[api]", req.method, new URL(req.url).pathname, err);
      return Response.json({ ok: false, error: "Something went wrong." }, { status: 500 });
    }
  };
}

/** Reads and validates a JSON body. A malformed body is a 400, not a 500. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Couldn't read that request.");
  }
}
