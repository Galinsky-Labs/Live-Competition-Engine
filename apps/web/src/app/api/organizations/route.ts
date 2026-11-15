import { createOrganization, OrganizationError } from "@live-competition-engine/db/organizations";
import { errorResponse, readJsonObject, route } from "@/lib/http";
import { requireAccount } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const principal = await requireAccount(request);
  const body = await readJsonObject(request, 4096);
  try {
    return Response.json(await createOrganization(principal.accountId, body.name, body.slug), { status: 201 });
  } catch (error) {
    if (error instanceof OrganizationError) return errorResponse(error.code === "slug_taken" ? 409 : 400, error.code);
    throw error;
  }
});
