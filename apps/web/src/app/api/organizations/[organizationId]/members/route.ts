import { normalizeEmail } from "@live-competition-engine/auth/credentials";
import { addMemberByEmail } from "@live-competition-engine/db/organizations";
import { errorResponse, readJsonObject, requireUuid, route } from "@/lib/http";
import { requireAction } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request, context: { params: Promise<{ organizationId: string }> }) => {
  const organizationId = requireUuid((await context.params).organizationId);
  const principal = await requireAction(request, "tenant.manage", { organizationId });
  const email = normalizeEmail((await readJsonObject(request, 4096)).email);
  if (!email) return errorResponse(400, "email_invalid");
  const accountId = await addMemberByEmail(organizationId, principal.accountId, email);
  if (!accountId) return errorResponse(404, "account_not_found");
  return Response.json({ accountId }, { status: 201 });
});
