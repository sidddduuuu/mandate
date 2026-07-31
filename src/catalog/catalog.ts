import { z } from "zod";

import {
  AuthError,
  type ActorContext,
  type ActorType,
} from "../auth/context.ts";
import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError, parseRequest } from "../http.ts";
import {
  mandatePolicySchema,
  type MandatePolicyData,
} from "../procurement/mandates.ts";
import { POLICY_CAPS } from "../procurement/policy.ts";

const identifier = z.string().trim().min(1).max(128);
const utcTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
).refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const catalogItemSchema = z.object({
  sku: identifier,
  unitPriceMinor: z.number().int().positive().max(POLICY_CAPS.unitPriceMinor),
  currency: z.string().regex(/^[A-Z]{3}$/),
  advisoryQuantity: z.number().int().nonnegative().max(POLICY_CAPS.quantity),
  validFrom: utcTimestamp,
  validUntil: utcTimestamp,
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  active: z.boolean(),
}).strict().refine((item) => item.validUntil > item.validFrom);
const catalogUpdateSchema = z.object({
  items: z.array(catalogItemSchema).min(1).max(100)
    .refine((items) => new Set(items.map(({ sku }) => sku)).size === items.length),
}).strict();
const offerQuerySchema = z.object({
  productKey: identifier,
  unit: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(POLICY_CAPS.quantity),
  deliveryLocationId: identifier,
}).strict();

export type CatalogItem = Readonly<{
  id: string;
  sku: string;
  productKey: string;
  category: string;
  unit: string;
  unitPriceMinor: number;
  currency: string;
  advisoryQuantity: number;
  version: number;
}>;

export type EligibleOffer = CatalogItem & Readonly<{
  supplierOrganizationId: string;
  totalMinor: number;
}>;

async function requireOrganization(
  database: Database,
  actor: ActorContext,
  actorType: ActorType,
  kind: "buyer" | "supplier",
  scope: string,
  lock = false,
): Promise<string> {
  if (actor.actorType !== actorType || !actor.scopes.includes(scope)) {
    throw new AuthError("forbidden");
  }
  const lockClause = lock && !("prepare" in database) ? " FOR UPDATE" : "";
  const organization = await database.get(
    `SELECT id, kind FROM organizations WHERE auth0_org_id = ?${lockClause}`,
    actor.organizationId,
  );
  if (typeof organization?.id !== "string" || organization.kind !== kind) {
    throw new AuthError("forbidden");
  }
  return organization.id;
}

function catalogItem(row: Record<string, unknown>): CatalogItem {
  return Object.freeze({
    id: String(row.id),
    sku: String(row.sku),
    productKey: String(row.product_key),
    category: String(row.category),
    unit: String(row.unit),
    unitPriceMinor: Number(row.unit_price),
    currency: String(row.currency),
    advisoryQuantity: Number(row.advisory_quantity),
    version: Number(row.version),
  });
}

export async function updateCatalog(
  database: Database,
  actor: ActorContext,
  input: unknown,
  requestId: string,
  now = new Date(),
): Promise<readonly CatalogItem[]> {
  const { items } = parseRequest(catalogUpdateSchema, input);
  const updatedAt = now.toISOString();

  return withImmediateTransaction(database, async (transaction) => {
    const supplierId = await requireOrganization(
      transaction, actor, "supplier_agent", "supplier", "catalog:write", true,
    );
    const updated: CatalogItem[] = [];
    for (const item of items) {
      const row = await transaction.get(`
        UPDATE catalog_items SET
          unit_price = ?, currency = ?, advisory_quantity = ?, valid_from = ?,
          valid_until = ?, display_name = ?, description = ?, active = ?,
          version = version + 1, updated_at = ?
        WHERE supplier_organization_id = ? AND sku = ?
        RETURNING id, sku, product_key, category, unit, unit_price, currency,
          advisory_quantity, version
      `,
        item.unitPriceMinor, item.currency, item.advisoryQuantity,
        item.validFrom, item.validUntil, item.displayName, item.description,
        item.active ? 1 : 0, updatedAt, supplierId, item.sku,
      );
      if (!row) {
        throw new ApiError(
          400,
          "UNKNOWN_SKU",
          "Catalog contains an unknown registered SKU",
        );
      }
      updated.push(catalogItem(row));
    }
    await transaction.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('catalog', ?, ?, 'catalog.updated', ?, ?, ?, ?, ?)
    `,
      supplierId, supplierId, actor.actorType, actor.subject, requestId,
      JSON.stringify({ items: updated.map(({ sku, version }) => ({ sku, version })) }),
      updatedAt,
    );
    return Object.freeze(updated);
  });
}

async function activePolicy(
  database: Database,
  buyerId: string,
  now: string,
): Promise<MandatePolicyData | null> {
  const row = await database.get(`
    SELECT policy_json, schema_version FROM mandates
    WHERE buyer_organization_id = ? AND state = 'active'
      AND valid_from <= ? AND valid_until > ?
  `, buyerId, now, now);
  if (row?.schema_version !== 1 || typeof row.policy_json !== "string") {
    return null;
  }
  const policy = mandatePolicySchema.parse(JSON.parse(row.policy_json));
  if (
    policy.budgetWindow.start > now
    || policy.budgetWindow.end <= now
  ) return null;
  return policy;
}

export async function findEligibleOffers(
  database: Database,
  actor: ActorContext,
  input: unknown,
  now = new Date(),
): Promise<readonly EligibleOffer[]> {
  const buyerId = await requireOrganization(
    database, actor, "buyer_agent", "buyer", "offers:read",
  );
  const query = parseRequest(offerQuerySchema, input);
  const timestamp = now.toISOString();
  const policy = await activePolicy(database, buyerId, timestamp);
  if (
    !policy
    || !policy.allowedDeliveryLocationIds.includes(query.deliveryLocationId)
  ) return Object.freeze([]);

  const rows = await database.all(`
    SELECT id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, version
    FROM catalog_items
    WHERE product_key = ? AND unit = ? AND active = 1
      AND valid_from <= ? AND valid_until > ?
      AND advisory_quantity >= ? AND unit_price <= ?
    ORDER BY unit_price, supplier_organization_id, id
  `,
    query.productKey, query.unit, timestamp, timestamp, query.quantity,
    Math.floor(POLICY_CAPS.orderTotalMinor / query.quantity),
  );

  return Object.freeze(rows.flatMap((row) => {
    const item = catalogItem(row);
    const supplierOrganizationId = String(row.supplier_organization_id);
    if (
      item.currency !== policy.currency
      || !policy.allowedSupplierOrgIds.includes(supplierOrganizationId)
      || !policy.allowedCategories.includes(item.category)
    ) return [];
    return [Object.freeze({
      ...item,
      supplierOrganizationId,
      totalMinor: item.unitPriceMinor * query.quantity,
    })];
  }));
}
