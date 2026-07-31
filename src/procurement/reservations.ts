import type { Database } from "../db.ts";
import type { MandatePolicyData } from "./mandates.ts";
import { POLICY_CAPS } from "./policy.ts";

export type ReservableOffer = Readonly<{
  id: string;
  supplierOrganizationId: string;
  sku: string;
  productKey: string;
  category: string;
  unit: string;
  unitPriceMinor: number;
  currency: string;
  version: number;
}>;

type ReservedOffer = Readonly<{
  id: string;
  version: number;
  quantity: number;
}>;

export async function selectOffer(
  database: Database,
  input: Readonly<{ productKey: string; unit: string; quantity: number }>,
  policy: MandatePolicyData,
  now: string,
): Promise<ReservableOffer | null> {
  const rows = await database.all(`
    SELECT id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, version
    FROM catalog_items
    WHERE product_key = ? AND unit = ? AND active = 1
      AND valid_from <= ? AND valid_until > ?
      AND advisory_quantity - COALESCE((
        SELECT SUM(reservation.quantity) FROM offer_reservations reservation
        WHERE reservation.catalog_item_id = catalog_items.id
          AND reservation.catalog_item_version = catalog_items.version
          AND reservation.status IN ('reserved', 'settled')
      ), 0) >= ? AND unit_price <= ?
    ORDER BY unit_price, supplier_organization_id, id
  `,
    input.productKey, input.unit, now, now, input.quantity,
    Math.floor(POLICY_CAPS.orderTotalMinor / input.quantity),
  );
  const row = rows.find((candidate) =>
    policy.allowedSupplierOrgIds.includes(String(candidate.supplier_organization_id))
    && policy.allowedCategories.includes(String(candidate.category))
    && candidate.currency === policy.currency
  );
  return row ? Object.freeze({
    id: String(row.id),
    supplierOrganizationId: String(row.supplier_organization_id),
    sku: String(row.sku),
    productKey: String(row.product_key),
    category: String(row.category),
    unit: String(row.unit),
    unitPriceMinor: Number(row.unit_price),
    currency: String(row.currency),
    version: Number(row.version),
  }) : null;
}

export async function reserveOffer(
  database: Database,
  orderId: string,
  offer: ReservedOffer,
  now: string,
): Promise<boolean> {
  const prior = await database.get(`
    SELECT catalog_item_id, catalog_item_version, quantity, status
    FROM offer_reservations WHERE order_id = ?
  `, orderId);
  if (prior) {
    return prior.catalog_item_id === offer.id
      && Number(prior.catalog_item_version) === offer.version
      && Number(prior.quantity) === offer.quantity
      && prior.status === "reserved";
  }
  const item = await database.get(`
    SELECT version, advisory_quantity, active, valid_from, valid_until
    FROM catalog_items WHERE id = ? FOR UPDATE
  `, offer.id);
  if (
    !item
    || item.active !== 1
    || Number(item.version) !== offer.version
    || typeof item.valid_from !== "string"
    || item.valid_from > now
    || typeof item.valid_until !== "string"
    || item.valid_until <= now
  ) return false;
  const reserved = await database.get(`
    SELECT COALESCE(SUM(quantity), 0) AS quantity
    FROM offer_reservations
    WHERE catalog_item_id = ? AND catalog_item_version = ?
      AND status IN ('reserved', 'settled')
  `, offer.id, offer.version);
  if (Number(item.advisory_quantity) - Number(reserved?.quantity ?? 0) < offer.quantity) {
    return false;
  }
  const inserted = await database.run(`
    INSERT INTO offer_reservations (
      order_id, catalog_item_id, catalog_item_version, quantity, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
  `, orderId, offer.id, offer.version, offer.quantity, now, now);
  return inserted.changes === 1;
}

export async function releaseOfferReservation(
  database: Database,
  orderId: string,
  now: string,
): Promise<void> {
  await database.run(`
    UPDATE offer_reservations SET status = 'released', updated_at = ?
    WHERE order_id = ? AND status = 'reserved'
  `, now, orderId);
}

export async function settleOfferReservation(
  database: Database,
  orderId: string,
  now: string,
): Promise<void> {
  const reservation = await database.get(`
    SELECT status FROM offer_reservations WHERE order_id = ? FOR UPDATE
  `, orderId);
  if (!reservation) return;
  if (reservation.status === "settled") return;
  if (reservation.status !== "reserved") {
    throw new Error("Released inventory cannot be settled");
  }
  const updated = await database.run(`
    UPDATE offer_reservations SET status = 'settled', updated_at = ?
    WHERE order_id = ? AND status = 'reserved'
  `, now, orderId);
  if (updated.changes !== 1) {
    throw new Error("Offer settlement lost its compare-and-set");
  }
}
