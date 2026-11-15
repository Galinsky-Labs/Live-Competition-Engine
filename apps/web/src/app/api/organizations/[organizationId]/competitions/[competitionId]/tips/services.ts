import { isFeatureEnabled } from "@live-competition-engine/db/feature-guard";
import { checkoutUrls, paymentProvider } from "@live-competition-engine/db/payment-runtime";
import { createGift, linkParticipantPayoutAccount, listEventTips, listGifts, quoteTip, sendTip, setTipPolicy } from "@live-competition-engine/db/tips";
import { authService } from "../../../../../../../lib/services";
import { orderView } from "../../../payments/handlers";
import { createTipHandlers } from "./handlers";

let handlers: ReturnType<typeof createTipHandlers> | undefined;

export function tipHandlers() {
  handlers ??= createTipHandlers(authService(), {
    listGifts,
    createGift,
    setPolicy: setTipPolicy,
    linkPayout: linkParticipantPayoutAccount,
    quote: quoteTip,
    send: (organizationId, input) => sendTip(organizationId, input, paymentProvider(), id => checkoutUrls(organizationId, id)),
    feed: async (organizationId, eventId, accountId) =>
      (await isFeatureEnabled("tips_gifts", { organizationId, eventId, accountId }))
        ? (await listEventTips(organizationId, eventId)).map(tip => ({
            id: tip.id, payeeType: tip.payee_type, payeeId: tip.payee_id, giftId: tip.gift_id, quantity: tip.quantity,
            amountMinor: Number(tip.amount), currency: tip.currency, message: tip.message, createdAt: tip.created_at
          }))
        : [],
    orderView
  });
  return handlers;
}
