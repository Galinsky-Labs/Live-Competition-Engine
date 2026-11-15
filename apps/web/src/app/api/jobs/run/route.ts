import { jobRunHandler } from "@/lib/notification-services";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return jobRunHandler()(request);
}
