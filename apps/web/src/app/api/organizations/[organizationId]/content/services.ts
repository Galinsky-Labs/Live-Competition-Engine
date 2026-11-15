import { checkoutUrls, paymentProvider } from "@live-competition-engine/db/payment-runtime";
import { createContent, getContentForViewer, listContentForViewer, purchaseContent } from "@live-competition-engine/db/paywalls";
import { authService } from "../../../../../lib/services";
import { orderView } from "../payments/handlers";
import { createContentHandlers } from "./handlers";

let handlers: ReturnType<typeof createContentHandlers> | undefined;

export function contentHandlers() {
  handlers ??= createContentHandlers(authService(), {
    list: listContentForViewer,
    get: getContentForViewer,
    create: createContent,
    purchase: (organizationId, input) => purchaseContent(organizationId, input, paymentProvider(), id => checkoutUrls(organizationId, id)),
    orderView
  });
  return handlers;
}
