import { listApprovals, serializeOrder } from "@/procurement/orders";
import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const orders = listApprovals(db, actor.organizationId);
      return jsonOk(
        { approvals: orders.map((o) => serializeOrder(o, "buyer")) },
        { requestId },
      );
    },
    {
      humanPermission: "approvals:read",
      rateLimit: { limit: 120, windowMs: 60_000 },
    },
  );
}
