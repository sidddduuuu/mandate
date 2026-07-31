import type { DatabaseSync } from "node:sqlite";
import { audit, now } from "@/db";

const MAX_ITEMS = 100;
const allowedItemFields = new Set([
  "sku",
  "unit_price_minor",
  "currency",
  "advisory_quantity",
  "valid_from",
  "valid_until",
  "display_name",
  "description",
]);

type OfferInput = {
  sku: string;
  unit_price_minor: number;
  currency: string;
  advisory_quantity: number;
  valid_from: string;
  valid_until: string;
  display_name: string;
  description: string;
};

export class CatalogError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
  );
}

function utc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseItem(value: unknown): OfferInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogError("invalid_catalog_item");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !allowedItemFields.has(key))) {
    throw new CatalogError("unsupported_catalog_field");
  }
  if (!boundedString(item.sku, 1, 80)) throw new CatalogError("invalid_sku");
  if (
    !Number.isSafeInteger(item.unit_price_minor) ||
    (item.unit_price_minor as number) < 1 ||
    (item.unit_price_minor as number) > 1_000_000_000
  ) {
    throw new CatalogError("invalid_unit_price");
  }
  if (typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)) {
    throw new CatalogError("invalid_currency");
  }
  if (
    !Number.isSafeInteger(item.advisory_quantity) ||
    (item.advisory_quantity as number) < 0 ||
    (item.advisory_quantity as number) > 1_000_000
  ) {
    throw new CatalogError("invalid_advisory_quantity");
  }
  if (!utc(item.valid_from) || !utc(item.valid_until)) {
    throw new CatalogError("invalid_offer_validity");
  }
  if (Date.parse(item.valid_from) >= Date.parse(item.valid_until)) {
    throw new CatalogError("invalid_offer_validity");
  }
  if (!boundedString(item.display_name, 1, 120)) {
    throw new CatalogError("invalid_display_name");
  }
  if (!boundedString(item.description, 0, 500)) {
    throw new CatalogError("invalid_description");
  }
  return item as OfferInput;
}

export function parseCatalog(value: unknown): OfferInput[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "items") ||
    !Array.isArray((value as { items: unknown }).items)
  ) {
    throw new CatalogError("invalid_catalog");
  }
  const values = (value as { items: unknown[] }).items;
  if (values.length > MAX_ITEMS) throw new CatalogError("catalog_too_large");
  const items = values.map(parseItem);
  if (new Set(items.map((item) => item.sku)).size !== items.length) {
    throw new CatalogError("duplicate_sku");
  }
  return items;
}

export function replaceCatalog(input: {
  db: DatabaseSync;
  organizationId: string;
  actorSubject: string;
  requestId: string;
  items: OfferInput[];
}) {
  const { db, organizationId, actorSubject, requestId, items } = input;
  const registered = db
    .prepare(`
      SELECT sku FROM catalog_items WHERE supplier_organization_id = ?
    `)
    .all(organizationId) as { sku: string }[];
  const registeredSkus = new Set(registered.map(({ sku }) => sku));
  if (items.some(({ sku }) => !registeredSkus.has(sku))) {
    throw new CatalogError("unknown_sku");
  }

  const get = db.prepare(`
    SELECT unit_price_minor, currency, advisory_quantity, valid_from, valid_until,
           display_name, description, active, version
    FROM catalog_items
    WHERE supplier_organization_id = ? AND sku = ?
  `);
  const activate = db.prepare(`
    UPDATE catalog_items SET
      unit_price_minor = ?, currency = ?, advisory_quantity = ?, valid_from = ?,
      valid_until = ?, display_name = ?, description = ?, active = 1,
      version = version + 1, updated_at = ?
    WHERE supplier_organization_id = ? AND sku = ?
  `);
  const deactivate = db.prepare(`
    UPDATE catalog_items
    SET active = 0, version = version + 1, updated_at = ?
    WHERE supplier_organization_id = ? AND active = 1 AND sku NOT IN (
      SELECT value FROM json_each(?)
    )
  `);

  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const current = get.get(organizationId, item.sku) as Record<string, unknown>;
      const differs =
        current.active !== 1 ||
        current.unit_price_minor !== item.unit_price_minor ||
        current.currency !== item.currency ||
        current.advisory_quantity !== item.advisory_quantity ||
        current.valid_from !== item.valid_from ||
        current.valid_until !== item.valid_until ||
        current.display_name !== item.display_name ||
        current.description !== item.description;
      if (differs) {
        activate.run(
          item.unit_price_minor,
          item.currency,
          item.advisory_quantity,
          item.valid_from,
          item.valid_until,
          item.display_name,
          item.description,
          now(),
          organizationId,
          item.sku,
        );
        changed += 1;
      }
    }
    const deactivated = deactivate.run(
      now(),
      organizationId,
      JSON.stringify(items.map(({ sku }) => sku)),
    );
    changed += Number(deactivated.changes);
    audit({
      organizationId,
      eventType: "catalog.published",
      actorType: "supplier",
      actorSubject,
      requestId,
      payload: { item_count: items.length, changed_count: changed },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const catalog = db
    .prepare(`
      SELECT sku, product_key, category, unit, unit_price_minor, currency,
             advisory_quantity, valid_from, valid_until, display_name,
             description, active, version, updated_at
      FROM catalog_items
      WHERE supplier_organization_id = ?
      ORDER BY sku
    `)
    .all(organizationId);
  return { changed_count: changed, items: catalog };
}
