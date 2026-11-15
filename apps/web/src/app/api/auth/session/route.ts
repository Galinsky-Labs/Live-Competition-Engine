import { accountSummary } from "@live-competition-engine/db/credential-store";
import { route } from "@/lib/http";
import { requireAccount } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  const principal = await requireAccount(request);
  return Response.json(await accountSummary(principal.accountId));
});
