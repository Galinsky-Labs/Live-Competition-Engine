import { fulfillmentHooks } from "@live-competition-engine/db/payment-fulfillment";
import { checkoutUrls, lazyPaymentProvider } from "@live-competition-engine/db/payment-runtime";
import {
  checkEventAccess,
  createTicketType,
  entryFeeGate,
  listTicketTypes,
  purchaseEntryFee,
  purchaseTicket,
  setEntryFee,
  setTicketTypeStatus,
  ticketTypeView
} from "@live-competition-engine/db/ticketing";
import { authService } from "../../../../../../../lib/services";
import { orderView } from "../../../payments/handlers";
import { createTicketingHandlers } from "./handlers";

let handlers: ReturnType<typeof createTicketingHandlers> | undefined;

export function ticketingHandlers() {
  handlers ??= createTicketingHandlers(authService(), {
    list: listTicketTypes,
    view: type => ticketTypeView(type),
    create: createTicketType,
    setStatus: setTicketTypeStatus,
    purchase: (organizationId, input) =>
      purchaseTicket(organizationId, input, lazyPaymentProvider(), orderId => checkoutUrls(organizationId, orderId), fulfillmentHooks()),
    access: (organizationId, eventId, accountId, mode) => checkEventAccess(organizationId, eventId, accountId, mode),
    entryFeeGate,
    setEntryFee,
    purchaseEntryFee: (organizationId, input) =>
      purchaseEntryFee(organizationId, input, lazyPaymentProvider(), orderId => checkoutUrls(organizationId, orderId)),
    orderView
  });
  return handlers;
}
