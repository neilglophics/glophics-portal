import { readJson, requireUser, withApi } from "@/lib/auth/require";
import { createAccount, type AccountInput } from "@/lib/db/queries/config";
import { notifyConfig } from "@/lib/revalidate";
import { socketIdFrom } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * A client, and the repository slots every environment under it will carry.
 *
 * `displayName` is what Jira's "Account Name" field is matched against, so it is
 * a business identifier and not just a label — renaming one changes which
 * tickets match.
 */
export const POST = withApi(async (req: Request) => {
  await requireUser("configure");

  const body = await readJson<Partial<AccountInput>>(req);
  const result = await createAccount({
    displayName: String(body.displayName ?? ""),
    repositories: Array.isArray(body.repositories) ? body.repositories.map(String) : [],
  });

  if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });

  await notifyConfig("account.changed", { accountId: result.value.id }, { socketId: socketIdFrom(req) });
  return Response.json({ ok: true, id: result.value.id });
});
