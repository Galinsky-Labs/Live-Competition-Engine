import { authService, platformAdminDeps } from "../../../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "../../handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.listNotes(request, organizationId);
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.addNote(request, organizationId);
}
