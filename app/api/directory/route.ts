import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { createDirectoryPerson, type DirectoryInput } from "@/lib/db/queries/config";
import { revalidateConfig } from "@/lib/revalidate";

export const runtime = "nodejs";

/**
 * Add someone to the people directory — assignable to a claim, with no login.
 * Most of the board is only ever this; a login is a separate record.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("configure");

  const body = await readJson<Partial<DirectoryInput>>(req);
  const result = await createDirectoryPerson({
    name: String(body.name ?? ""),
    jobRole: body.jobRole ? String(body.jobRole) : "",
    jiraNames: body.jiraNames,
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  revalidateConfig();
  return Response.json({ ok: true, id: result.value.id });
});
