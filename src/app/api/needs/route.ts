import { AppError, jsonOk } from "@/lib/http";
import { readJson, withApi } from "@/lib/api";
import {
  dismissPurchaseNeed,
  listPurchaseNeeds,
  serializePurchaseNeed,
} from "@/store/operations";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const needs = listPurchaseNeeds(
        db,
        actor.organizationId,
        status === "open" || status === "ordered" || status === "dismissed"
          ? status
          : undefined,
      ).map(serializePurchaseNeed);
      return jsonOk({ needs }, { requestId });
    },
    { humanPermission: "orders:read" },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const body = (await readJson(request)) as { id?: string };
      if (!body.id?.trim()) {
        throw new AppError(400, "invalid_request", "Need id is required");
      }
      const need = dismissPurchaseNeed(db, actor, body.id, requestId);
      return jsonOk({ need: serializePurchaseNeed(need) }, { requestId });
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
    },
  );
}
