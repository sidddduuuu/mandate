import { createOrder, serializeOrder } from "@/procurement/orders";
import { AppError, jsonOk } from "@/lib/http";
import { getStripe, readJson, withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) {
        throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key header is required");
      }
      const body = await readJson(request);
      const { order, httpStatus } = await createOrder(
        db,
        actor,
        body,
        idempotencyKey,
        requestId,
        getStripe(),
      );
      return jsonOk(serializeOrder(order, "buyer"), { status: httpStatus, requestId });
    },
    {
      agentScope: "orders:create",
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
