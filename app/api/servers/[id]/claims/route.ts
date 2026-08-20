import { revalidatePath } from "next/cache";
import { requireUser, withApi } from "@/lib/auth/require";
import { releaseServerClaims } from "@/lib/db/queries/claims";

export const runtime = "nodejs";

/** Force free an entire environment — every claim on it at once. */
export const DELETE = withApi(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser("claim");

  const { id } = await ctx.params;
  const serverId = decodeURIComponent(id);
  const result = await releaseServerClaims(serverId);

  if (!result.ok) {
    return Response.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  for (const path of ["/dashboard", "/environments", "/tickets", "/my-tickets", "/in-use"]) {
    revalidatePath(path);
  }
  revalidatePath(`/environments/${serverId}`);

  return Response.json({ ok: true, released: result.value.released });
});
