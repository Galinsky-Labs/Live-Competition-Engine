import { featureControlHandlers } from "@/lib/feature-control-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return featureControlHandlers().platformOverrides(request);
}
