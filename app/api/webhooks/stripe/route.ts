import { withDatabase } from "../../../../src/db.ts";
import { ok, route } from "../../../../src/http.ts";
import {
  paymentEvent,
  reconcileStripeEvent,
  verifyStripeWebhook,
} from "../../../../src/webhooks/stripe.ts";

export const runtime = "nodejs";

export function POST(request: Request) {
  return route(async (requestId) => {
    const verified = await verifyStripeWebhook(request);
    const event = paymentEvent(verified);
    return withDatabase(async (database) => {
      if (event) {
        await reconcileStripeEvent(database, event, requestId);
      }
      const response = ok({ received: true });
      response.headers.set("cache-control", "no-store");
      return response;
    });
  });
}
