import { abandonFailedPayment, serializeOrder } from "@/procurement/orders";
import { jsonOk } from "@/lib/http";
import { getStripe, withApi } from "@/lib/api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** MVP (#7): human abandons a payment_failed order after Stripe cancel. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const { id } = await context.params;
      const order = await abandonFailedPayment(db, actor, id, requestId, getStripe());
      return jsonOk(serializeOrder(order, "buyer"), { requestId });
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
      rateLimit: { limit: 30, windowMs: 60_000 },
    },
  );
}
