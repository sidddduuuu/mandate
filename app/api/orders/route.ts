import { z } from "zod";

import { verifyAuth0Bearer } from "../../../src/auth/context.ts";
import { withDatabase } from "../../../src/db.ts";
import {
  rateLimit,
  readJson,
  route,
} from "../../../src/http.ts";
import { settleOrderFromWallet } from "../../../src/payments/wallet.ts";
import {
  orderResponse,
  requireIdempotencyKey,
} from "../../../src/procurement/order-http.ts";
import { createOrder } from "../../../src/procurement/orders.ts";

export const runtime = "nodejs";

export function POST(request: Request) {
  return route(async (requestId) => {
    const actor = await verifyAuth0Bearer(
      request.headers.get("authorization"),
      { actorTypes: ["buyer_agent"], scopes: ["orders:create"] },
    );
    return withDatabase(async (database) => {
      await rateLimit(database, `orders:create:${actor.subject}`, 30);
      const idempotencyKey = requireIdempotencyKey(
        request.headers.get("idempotency-key"),
      );
      const input = await readJson(request, z.unknown());
      const result = await createOrder(
        database,
        actor,
        input,
        idempotencyKey,
        requestId,
      );
      if (
        result.kind === "order"
        && result.order.policyDecision === "allow"
        && result.order.status === "payment_pending"
      ) await settleOrderFromWallet(database, result.order.id, requestId);
      return orderResponse(result);
    });
  });
}
