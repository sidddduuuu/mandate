import { decideApproval, serializeOrder } from "@/procurement/orders";
import { jsonOk } from "@/lib/http";
import { getStripe, readJson, withApi } from "@/lib/api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const { id } = await context.params;
      const body = await readJson(request);
      const order = await decideApproval(db, actor, id, body, requestId, getStripe());
      return jsonOk(serializeOrder(order, "buyer"), { requestId });
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
