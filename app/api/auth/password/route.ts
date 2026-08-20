import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { createSession } from "@/lib/auth/session";
import { changeOwnPassword } from "@/lib/db/queries/auth";

export const runtime = "nodejs";

/**
 * Changing your own password drops every session you had — including the one you
 * are using to change it. So a fresh one is issued immediately afterwards, or
 * you would be signed out of the tab you just used.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  const { currentPassword, newPassword } = await readJson<{
    currentPassword?: string;
    newPassword?: string;
  }>(req);

  const result = await changeOwnPassword(user.id, currentPassword, newPassword);
  if (!result.ok) throw new HttpError(400, result.errors.join(" "), { errors: result.errors });

  await createSession(user.id);
  return Response.json({ ok: true });
});
