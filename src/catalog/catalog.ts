import { z } from "zod";
import type { Db } from "../db";
import { withImmediateTransaction } from "../db";
import { writeAudit } from "../audit/audit";
import type { ActorContext } from "../auth/context";
import { getConfig } from "../lib/config";
import { AppError } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { assertSafeNonNegativeInt, assertSafePositiveInt } from "../lib/money";

const catalogUpdateItemSchema = z.object({
  sku: z.string().min(1).max(64),
  unit_price_minor: z.number().int().positive(),
  currency: z.string().length(3),
  advisory_quantity: z.number().int().nonnegative(),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime(),
  display_name: z.string().min(1).max(200),
  display_description: z.string().max(2000).default(""),
  active: z.boolean(),
});

export const catalogUpdateSchema = z.object({
  items: z.array(catalogUpdateItemSchema).max(200),
});

export type CatalogItemRow = {
  id: string;
  supplier_org_id: string;
  sku: string;
  product_key: string;
  category: string;
  unit: string;
  unit_price_minor: number;
  currency: string;
  advisory_quantity: number;
  valid_from: string;
  valid_until: string;
  display_name: string;
  display_description: string;
  active: number;
  version: number;
  updated_at: string;
};

/**
 * MVP decision (#2): omitted registered SKUs remain unchanged.
 * Unknown SKUs are rejected. Classification fields are immutable.
 * Empty items array is a no-op success.
 */
export function updateCatalog(
  db: Db,
  actor: ActorContext,
  rawBody: unknown,
  requestId: string,
): CatalogItemRow[] {
  const parsed = catalogUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Invalid catalog payload");
  }

  const cfg = getConfig();
  const now = nowIso();

  return withImmediateTransaction(db, () => {
    const updated: CatalogItemRow[] = [];
    for (const item of parsed.data.items) {
      assertSafePositiveInt(item.unit_price_minor, "unit_price_minor");
      assertSafeNonNegativeInt(item.advisory_quantity, "advisory_quantity");
      if (item.unit_price_minor > cfg.MAX_UNIT_PRICE_MINOR) {
        throw new AppError(400, "invalid_request", "unit_price exceeds maximum");
      }
      if (Date.parse(item.valid_until) <= Date.parse(item.valid_from)) {
        throw new AppError(400, "invalid_request", "valid_until must be after valid_from");
      }

      const existing = db
        .prepare(
          `SELECT * FROM catalog_items WHERE supplier_org_id = ? AND sku = ?`,
        )
        .get(actor.organizationId, item.sku) as CatalogItemRow | undefined;

      if (!existing) {
        throw new AppError(
          400,
          "unknown_sku",
          `SKU ${item.sku} is not registered for this supplier`,
        );
      }

      db.prepare(
        `UPDATE catalog_items SET
          unit_price_minor = ?,
          currency = ?,
          advisory_quantity = ?,
          valid_from = ?,
          valid_until = ?,
          display_name = ?,
          display_description = ?,
          active = ?,
          version = version + 1,
          updated_at = ?
         WHERE id = ?`,
      ).run(
        item.unit_price_minor,
        item.currency.toUpperCase(),
        item.advisory_quantity,
        item.valid_from,
        item.valid_until,
        item.display_name,
        item.display_description,
        item.active ? 1 : 0,
        now,
        existing.id,
      );

      const row = db
        .prepare(`SELECT * FROM catalog_items WHERE id = ?`)
        .get(existing.id) as CatalogItemRow;
      updated.push(row);
    }

    writeAudit(db, {
      aggregateType: "catalog",
      organizationId: actor.organizationId,
      eventType: "catalog.updated",
      actorType: "agent",
      actorSubject: actor.subject,
      requestId,
      payload: {
        updated_skus: updated.map((u) => ({ sku: u.sku, version: u.version })),
      },
    });

    return updated;
  });
}

export type EligibleOffer = {
  catalog_item_id: string;
  supplier_org_id: string;
  sku: string;
  product_key: string;
  category: string;
  unit: string;
  unit_price_minor: number;
  currency: string;
  advisory_quantity: number;
  version: number;
  display_name: string;
  total_minor: number;
  eligible: boolean;
  reasons: string[];
};

export function listOffersForProduct(
  db: Db,
  params: {
    productKey: string;
    unit: string;
    quantity: number;
    deliveryLocationId: string;
    allowedSupplierOrgIds: string[];
    allowedCategories: string[];
    currency: string;
    nowIso: string;
  },
): CatalogItemRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM catalog_items
       WHERE product_key = ?
         AND unit = ?
         AND active = 1
         AND advisory_quantity >= ?
         AND valid_from <= ?
         AND valid_until >= ?
         AND currency = ?`,
    )
    .all(
      params.productKey,
      params.unit,
      params.quantity,
      params.nowIso,
      params.nowIso,
      params.currency,
    ) as CatalogItemRow[];

  return rows.filter(
    (r) =>
      params.allowedSupplierOrgIds.includes(r.supplier_org_id) &&
      params.allowedCategories.includes(r.category),
  );
}

export function serializeCatalogItem(row: CatalogItemRow) {
  return {
    id: row.id,
    supplier_org_id: row.supplier_org_id,
    sku: row.sku,
    product_key: row.product_key,
    category: row.category,
    unit: row.unit,
    unit_price_minor: row.unit_price_minor,
    currency: row.currency,
    advisory_quantity: row.advisory_quantity,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    display_name: row.display_name,
    display_description: row.display_description,
    active: row.active === 1,
    version: row.version,
    updated_at: row.updated_at,
  };
}

export function seedRegisteredSku(
  db: Db,
  input: {
    supplierOrgId: string;
    sku: string;
    productKey: string;
    category: string;
    unit: string;
    unitPriceMinor: number;
    currency: string;
    advisoryQuantity: number;
    validFrom: string;
    validUntil: string;
    displayName: string;
    displayDescription?: string;
    active?: boolean;
  },
): CatalogItemRow {
  const id = newId("cat");
  const now = nowIso();
  db.prepare(
    `INSERT INTO catalog_items (
      id, supplier_org_id, sku, product_key, category, unit,
      unit_price_minor, currency, advisory_quantity, valid_from, valid_until,
      display_name, display_description, active, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    input.supplierOrgId,
    input.sku,
    input.productKey,
    input.category,
    input.unit,
    input.unitPriceMinor,
    input.currency,
    input.advisoryQuantity,
    input.validFrom,
    input.validUntil,
    input.displayName,
    input.displayDescription ?? "",
    input.active === false ? 0 : 1,
    now,
  );
  return db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id) as CatalogItemRow;
}
