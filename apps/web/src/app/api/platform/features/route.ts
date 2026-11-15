import { featureControlHandlers } from "@/lib/feature-control-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return featureControlHandlers().platformList(request);
}

export async function POST(request: Request) {
  return featureControlHandlers().platformSet(request);
}
