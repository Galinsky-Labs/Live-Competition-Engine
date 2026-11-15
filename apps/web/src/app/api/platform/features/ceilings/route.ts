import { featureControlHandlers } from "@/lib/feature-control-services";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return featureControlHandlers().platformCeiling(request);
}
