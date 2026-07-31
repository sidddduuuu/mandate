import { getConfig } from "@/lib/config";
import { AppError, jsonOk } from "@/lib/http";
import { getStripe, withApi } from "@/lib/api";
import { buyerAgentForOrg } from "@/lib/buyer-agent";
import {
  listPurchaseNeeds,
  scanInventoryNeeds,
  seedDefaultInventory,
  serializePurchaseNeed,
} from "@/store/operations";

export const runtime = "nodejs";

/**
 * Store-owner demo action: ensure inventory rows, then run the buyer agent
 * restock scan that builds the purchase list.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      if (!getConfig().AUTH_TEST_MODE && actor.actorType !== "agent") {
        throw new AppError(
          403,
          "forbidden",
          "Inventory scan from the UI requires AUTH_TEST_MODE or an agent token",
        );
      }
      seedDefaultInventory(db, actor.organizationId);
      const agent = buyerAgentForOrg(db, actor);
      const touched = scanInventoryNeeds(db, agent, requestId);
      const needs = listPurchaseNeeds(db, actor.organizationId).map(serializePurchaseNeed);
      // keep stripe warm for subsequent place-order calls
      void getStripe();
      return jsonOk(
        {
          scanned: touched.length,
          needs,
        },
        { requestId },
      );
    },
    {
      humanPermission: "orders:read",
      csrf: true,
      rateLimit: { limit: 30, windowMs: 60_000 },
    },
  );
}
