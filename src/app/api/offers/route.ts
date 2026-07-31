import { writeAudit } from "@/audit/audit";
import { listOffersForProduct, serializeCatalogItem } from "@/catalog/catalog";
import { getConfig } from "@/lib/config";
import { AppError, jsonOk } from "@/lib/http";
import { computeOrderTotalMinor, MoneyError } from "@/lib/money";
import { withApi } from "@/lib/api";
import { nowIso } from "@/lib/ids";
import { getActiveMandate, mandateToPolicy } from "@/procurement/mandates";

export const runtime = "nodejs";

const QUERY_FIELDS = [
  "product_key",
  "unit",
  "quantity",
  "delivery_location_id",
] as const;
const NORMALIZED_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const NORMALIZED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const deny = (
        status: number,
        code: string,
        message: string,
        details: Record<string, unknown> = {},
      ): never => {
        writeAudit(db, {
          aggregateType: "offer_selection",
          organizationId: actor.organizationId,
          eventType: "offer.denied",
          actorType: actor.actorType,
          actorSubject: actor.subject,
          requestId,
          payload: { reason: code, ...details },
        });
        throw new AppError(status, code, message);
      };

      if (actor.actorType !== "agent" || !actor.scopes.has("offers:read")) {
        deny(403, "forbidden", "Missing scope offers:read");
      }
      const organization = db
        .prepare(`SELECT kind FROM organizations WHERE id = ?`)
        .get(actor.organizationId) as { kind: "buyer" | "supplier" } | undefined;
      if (organization?.kind !== "buyer") {
        deny(403, "buyer_organization_required", "Buyer organization required");
      }

      const url = new URL(request.url);
      const keys = [...url.searchParams.keys()];
      if (
        keys.length !== QUERY_FIELDS.length ||
        QUERY_FIELDS.some(
          (field) => url.searchParams.getAll(field).length !== 1,
        ) ||
        keys.some(
          (key) => !QUERY_FIELDS.includes(key as (typeof QUERY_FIELDS)[number]),
        )
      ) {
        deny(
          400,
          "unsupported_request_field",
          "Request must contain only the supported discovery fields",
        );
      }

      const productKey = url.searchParams.get("product_key")!;
      const unit = url.searchParams.get("unit")!;
      const quantityText = url.searchParams.get("quantity")!;
      const deliveryLocationId = url.searchParams.get("delivery_location_id")!;
      const quantity = /^\d+$/.test(quantityText) ? Number(quantityText) : NaN;
      const cfg = getConfig();
      if (
        !NORMALIZED_KEY.test(productKey) ||
        !NORMALIZED_KEY.test(unit) ||
        !NORMALIZED_ID.test(deliveryLocationId) ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        quantity > cfg.MAX_QUANTITY
      ) {
        deny(400, "invalid_offer_request", "Offer request is invalid");
      }

      const mandate = getActiveMandate(db, actor.organizationId);
      if (!mandate) {
        return deny(403, "missing_mandate", "No active Purchasing Mandate");
      }
      const now = nowIso();
      if (
        Date.parse(mandate.valid_from) > Date.parse(now) ||
        Date.parse(mandate.valid_until) <= Date.parse(now)
      ) {
        deny(403, "inactive_mandate", "Purchasing Mandate is not active");
      }
      if (
        Date.parse(mandate.budget_window_start) > Date.parse(now) ||
        Date.parse(mandate.budget_window_end) <= Date.parse(now)
      ) {
        deny(403, "inactive_budget_window", "Budget Window is not active");
      }

      const policy = mandateToPolicy(mandate);
      if (!policy.allowed_delivery_location_ids.includes(deliveryLocationId)) {
        deny(403, "delivery_not_allowed", "Delivery location is not allowed", {
          product_key: productKey,
          unit,
        });
      }

      let unsafeTotal = false;
      const offers = listOffersForProduct(db, {
        productKey,
        unit,
        quantity,
        deliveryLocationId,
        allowedSupplierOrgIds: policy.allowed_supplier_org_ids,
        allowedCategories: policy.allowed_categories,
        currency: policy.currency,
        nowIso: now,
      })
        .map((offer) => {
          try {
            return {
              offer,
              total: computeOrderTotalMinor(offer.unit_price_minor, quantity, {
                maxUnitPrice: cfg.MAX_UNIT_PRICE_MINOR,
                maxQuantity: cfg.MAX_QUANTITY,
                maxOrderTotal: cfg.MAX_ORDER_TOTAL_MINOR,
              }),
            };
          } catch (error) {
            if (error instanceof MoneyError) {
              unsafeTotal = true;
              return null;
            }
            throw error;
          }
        })
        .filter(
          (
            candidate,
          ): candidate is {
            offer: NonNullable<typeof candidate>["offer"];
            total: number;
          } => candidate !== null,
        )
        .sort(
          (left, right) =>
            left.total - right.total ||
            left.offer.supplier_org_id.localeCompare(
              right.offer.supplier_org_id,
            ),
        );

      const selected = offers[0];
      if (!selected) {
        return deny(
          unsafeTotal ? 422 : 404,
          unsafeTotal ? "unsafe_order_total" : "no_eligible_offer",
          unsafeTotal
            ? "Eligible Offer total exceeds safe bounds"
            : "No eligible Offer is available",
          { product_key: productKey, unit },
        );
      }

      writeAudit(db, {
        aggregateType: "offer_selection",
        aggregateId: selected.offer.id,
        organizationId: actor.organizationId,
        eventType: "offer.selected",
        actorType: "agent",
        actorSubject: actor.subject,
        requestId,
        payload: {
          supplier_organization_id: selected.offer.supplier_org_id,
          sku: selected.offer.sku,
          offer_version: selected.offer.version,
          mandate_id: mandate.id,
          mandate_version: mandate.version,
          product_key: productKey,
          unit,
          quantity,
          total_minor: selected.total,
          currency: selected.offer.currency,
          delivery_location_id: deliveryLocationId,
        },
      });

      return jsonOk(
        {
          offer: {
            ...serializeCatalogItem(selected.offer),
            quantity,
            total_minor: selected.total,
            delivery_location_id: deliveryLocationId,
            mandate_version: mandate.version,
          },
        },
        { requestId },
      );
    },
    {
      rateLimit: { limit: 120, windowMs: 60_000 },
    },
  );
}
