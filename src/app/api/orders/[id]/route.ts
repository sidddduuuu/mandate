import {
  authenticateRequest,
  requireAgentScope,
  requireHumanPermission,
} from "@/auth/context";
import { getDb } from "@/db";
import { getOrderForActor, serializeOrder } from "@/procurement/orders";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRequestId, jsonError, jsonOk, toErrorResponse } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const db = getDb();
    const actor = await authenticateRequest(db, request, requestId);
    if (actor.actorType === "agent") requireAgentScope(actor, "orders:read");
    else requireHumanPermission(actor, "orders:read");

    const key = `${actor.subject}:GET:/api/orders/:id`;
    const rl = checkRateLimit(key, 120, 60_000);
    if (!rl.allowed) return jsonError(429, "rate_limited", "Rate limit exceeded", requestId);

    const { id } = await context.params;
    const order = getOrderForActor(db, actor, id);
    const projection =
      order.supplier_org_id === actor.organizationId &&
      order.buyer_org_id !== actor.organizationId
        ? "supplier"
        : "buyer";
    return jsonOk(serializeOrder(order, projection), { requestId });
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
