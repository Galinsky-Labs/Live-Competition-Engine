import { fulfillmentHooks } from "@live-competition-engine/db/payment-fulfillment";
import { verifyJobSecret } from "@live-competition-engine/db/payment-runtime";
import { expireLapsedSubscriptions } from "@live-competition-engine/db/subscriptions";
import { releaseExpiredHolds } from "@live-competition-engine/db/ticketing";
import { createPaymentJobHandler } from "./handler";

export const dynamic = "force-dynamic";

const handler = createPaymentJobHandler({
  verify: verifyJobSecret,
  tasks: {
    releasedHolds: now => releaseExpiredHolds(now, { hooks: fulfillmentHooks() }),
    expiredSubscriptions: now => expireLapsedSubscriptions(now)
  }
});

export async function POST(request: Request) {
  return handler(request);
}
