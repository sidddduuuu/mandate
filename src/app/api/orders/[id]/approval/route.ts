import {
  decideApproval,
  getOrderForActor,
  handleStripeWebhook,
  serializeOrder,
} from "@/procurement/orders";
import { jsonOk } from "@/lib/http";
import { getConfig } from "@/lib/config";
import { getStripe, readJson, withApi } from "@/lib/api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const { id } = await context.params;
      const body = await readJson(request);
      const stripe = getStripe();
      let order = await decideApproval(db, actor, id, body, requestId, stripe);

      // Demo / AUTH_TEST_MODE: no Stripe CLI webhook — settle succeeded
      // PaymentIntents so the UI reaches `paid` without extra tooling.
      // Unit tests call decideApproval directly and stay on payment_pending.
      if (
        getConfig().AUTH_TEST_MODE &&
        order.status === "payment_pending" &&
        order.stripe_payment_intent_id
      ) {
        const pi = await stripe.retrievePaymentIntent(order.stripe_payment_intent_id);
        if (pi.status === "succeeded") {
          handleStripeWebhook(
            db,
            {
              id: `evt_demo_${pi.id}`,
              type: "payment_intent.succeeded",
              data: {
                object: {
                  id: pi.id,
                  amount: pi.amount,
                  currency: pi.currency,
                  metadata: pi.metadata,
                },
              },
            },
            requestId,
          );
          order = getOrderForActor(db, actor, order.id);
        }
      }

      return jsonOk(serializeOrder(order, "buyer"), { requestId });
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
