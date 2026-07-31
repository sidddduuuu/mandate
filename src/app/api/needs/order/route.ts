import { getConfig } from "@/lib/config";
import { AppError, jsonOk } from "@/lib/http";
import { getStripe, withApi } from "@/lib/api";
import { buyerAgentForOrg } from "@/lib/buyer-agent";
import {
  ensureDeliveryForPaidOrder,
  placeOrdersForOpenNeeds,
  serializePurchaseNeed,
} from "@/store/operations";
import { serializeOrder } from "@/procurement/orders";

export const runtime = "nodejs";

/** Buyer agent places Mandate orders for every open purchase-list line. */
export async function POST(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      if (!getConfig().AUTH_TEST_MODE && actor.actorType !== "agent") {
        throw new AppError(
          403,
          "forbidden",
          "Placing agent orders from the UI requires AUTH_TEST_MODE",
        );
      }
      const agent = buyerAgentForOrg(db, actor);
      const placed = await placeOrdersForOpenNeeds(db, agent, requestId, getStripe());
      for (const row of placed) {
        if (row.order.status === "paid") {
          ensureDeliveryForPaidOrder(db, row.order, requestId);
        }
      }
      return jsonOk(
        {
          placed: placed.map(({ need, order }) => ({
            need: serializePurchaseNeed(need),
            order: serializeOrder(order, "buyer"),
          })),
        },
        { requestId },
      );
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
      rateLimit: { limit: 20, windowMs: 60_000 },
    },
  );
}
