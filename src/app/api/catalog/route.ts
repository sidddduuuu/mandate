import { serializeCatalogItem, updateCatalog } from "@/catalog/catalog";
import { jsonOk } from "@/lib/http";
import { readJson, withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function PUT(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const body = await readJson(request);
      const items = updateCatalog(db, actor, body, requestId);
      return jsonOk(
        { items: items.map(serializeCatalogItem) },
        { requestId },
      );
    },
    {
      agentScope: "catalog:write",
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
