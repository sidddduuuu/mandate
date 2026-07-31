import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  localDemoAuthorizationEnabled,
  requireHumanSession,
} from "../../../../src/auth/session.ts";
import { withDatabase } from "../../../../src/db.ts";
import {
  ApiError,
  ok,
  rateLimit,
  readJson,
  route,
} from "../../../../src/http.ts";
import { settleOrderFromWallet } from "../../../../src/payments/wallet.ts";
import { createOrder } from "../../../../src/procurement/orders.ts";

export const runtime = "nodejs";

export function POST(request: Request) {
  return route(async (requestId) => {
    if (!localDemoAuthorizationEnabled()) {
      throw new ApiError(404, "NOT_FOUND", "Route not found");
    }
    const human = await requireHumanSession(request, {
      permission: "orders:read",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `demo:agent-run:${human.subject}`, 10);
      const input = await readJson(request, z.object({
        productKey: z.enum(["hass-avocado", "persian-lime", "cilantro"]),
        quantity: z.number().int().positive().max(100),
        idempotencyKey: z.string().uuid().optional(),
      }).strict());

      const result = await createOrder(
        database,
        Object.freeze({
          subject: "inventory-agent-prod",
          organizationId: human.organizationId,
          actorType: "buyer_agent",
          scopes: Object.freeze(["orders:create"]),
        }),
        {
          productKey: input.productKey,
          unit: "case",
          quantity: input.quantity,
          deliveryLocationId: "mission-district-kitchen",
        },
        input.idempotencyKey ?? randomUUID(),
        requestId,
      );
      if (result.kind !== "order") {
        throw new ApiError(
          409,
          "AGENT_REQUEST_DENIED",
          "The purchasing mandate denied this request",
        );
      }
      if (result.order.status === "payment_pending") {
        await settleOrderFromWallet(database, result.order.id, requestId);
      }
      return ok({
        orderId: result.order.id,
        replayed: result.replayed,
        status: result.order.status,
      }, result.replayed ? 200 : 201);
    });
  });
}
