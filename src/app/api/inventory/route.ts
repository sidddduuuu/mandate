import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";
import { listInventory, serializeInventoryItem } from "@/store/operations";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const items = listInventory(db, actor.organizationId).map(serializeInventoryItem);
      return jsonOk({ items }, { requestId });
    },
    { humanPermission: "orders:read" },
  );
}
