import { listOffersForProduct, serializeCatalogItem } from "@/catalog/catalog";
import { getActiveMandate, mandateToPolicy } from "@/procurement/mandates";
import { computeOrderTotalMinor } from "@/lib/money";
import { getConfig } from "@/lib/config";
import { AppError, jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";
import { nowIso } from "@/lib/ids";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const url = new URL(request.url);
      const productKey = url.searchParams.get("product_key") ?? "";
      const unit = url.searchParams.get("unit") ?? "";
      const quantity = Number(url.searchParams.get("quantity") ?? "0");
      const deliveryLocationId = url.searchParams.get("delivery_location_id") ?? "";

      if (!productKey || !unit || !deliveryLocationId || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new AppError(400, "invalid_request", "Missing or invalid offer query parameters");
      }

      const mandate = getActiveMandate(db, actor.organizationId);
      if (!mandate) {
        throw new AppError(403, "missing_mandate", "No active purchasing mandate");
      }
      const policy = mandateToPolicy(mandate);
      const cfg = getConfig();
      const offers = listOffersForProduct(db, {
        productKey,
        unit,
        quantity,
        deliveryLocationId,
        allowedSupplierOrgIds: policy.allowed_supplier_org_ids,
        allowedCategories: policy.allowed_categories,
        currency: policy.currency,
        nowIso: nowIso(),
      }).map((offer) => {
        const total = computeOrderTotalMinor(offer.unit_price_minor, quantity, {
          maxUnitPrice: cfg.MAX_UNIT_PRICE_MINOR,
          maxQuantity: cfg.MAX_QUANTITY,
          maxOrderTotal: cfg.MAX_ORDER_TOTAL_MINOR,
        });
        return {
          ...serializeCatalogItem(offer),
          total_minor: total,
          eligible: true,
          reasons: ["ok"],
        };
      });

      return jsonOk({ offers }, { requestId });
    },
    {
      agentScope: "offers:read",
      rateLimit: { limit: 120, windowMs: 60_000 },
    },
  );
}
