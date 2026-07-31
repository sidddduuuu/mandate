import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";
import {
  ensureDeliveryForPaidOrder,
  listDeliveries,
  serializeDelivery,
} from "@/store/operations";
import type { OrderRow } from "@/procurement/orders";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      // Backfill deliveries for paid orders created before this feature.
      const paid = db
        .prepare(
          `SELECT * FROM orders
           WHERE buyer_org_id = ? AND status = 'paid'
           ORDER BY created_at DESC
           LIMIT 50`,
        )
        .all(actor.organizationId) as OrderRow[];
      for (const order of paid) {
        ensureDeliveryForPaidOrder(db, order, requestId);
      }
      const deliveries = listDeliveries(db, actor.organizationId).map(serializeDelivery);
      return jsonOk({ deliveries }, { requestId });
    },
    { humanPermission: "orders:read" },
  );
}
