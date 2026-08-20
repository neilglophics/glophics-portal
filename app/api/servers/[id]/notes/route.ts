import { HttpError, readJson, requireUser, withApi } from "@/lib/auth/require";
import { setRepoNote } from "@/lib/db/queries/claims";
import { notifyOccupancy } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * The free-text note on one repository. Blank clears it.
 *
 * A POST rather than a PUT because `SameSite=Lax` is the app's only CSRF defence
 * and it only covers non-GET requests — see docs/00 "Known problems" #9. Every
 * state-changing route in this app must stay a non-GET method for that reason.
 */
export const POST = withApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("claim");

  const { id } = await ctx.params;
  const serverId = decodeURIComponent(id);

  const body = await readJson<{ repoName?: string; text?: string }>(req);
  if (!body.repoName) throw new HttpError(400, "Which repository?");

  const result = await setRepoNote(serverId, body.repoName, String(body.text ?? ""));
  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  await notifyOccupancy(
    "note.changed",
    { serverId, repoName: body.repoName },
    { serverId, socketId: socketIdFrom(req) },
  );

  return Response.json({ ok: true });
});
