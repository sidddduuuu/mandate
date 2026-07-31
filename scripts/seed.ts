import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Database,
  withDatabase,
  withImmediateTransaction,
} from "../src/db.ts";
import { createOrder } from "../src/procurement/orders.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const VALID_UNTIL = "2099-01-01T00:00:00.000Z";
const BUYER_ID = "buyer-juniper";
const DELIVERY_LOCATION_ID = "mission-district-kitchen";

const SUPPLIERS = [
  {
    key: "greenline",
    id: "supplier-greenline",
    name: "Greenline Produce",
  },
  {
    key: "suncrest",
    id: "supplier-suncrest",
    name: "Suncrest Foods",
  },
  {
    key: "orchard",
    id: "supplier-orchard",
    name: "Orchard Market",
  },
] as const;

const PRODUCTS = [
  {
    key: "hass-avocado",
    name: "Hass avocados",
    sku: "HASS",
    prices: [2_133, 2_233, 2_300],
  },
  {
    key: "persian-lime",
    name: "Persian limes",
    sku: "LIME",
    prices: [1_200, 1_250, 1_320],
  },
  {
    key: "cilantro",
    name: "Cilantro",
    sku: "CIL",
    prices: [850, 900, 940],
  },
] as const;

export type DemoSeedConfig = Readonly<{
  buyerAuth0OrgId: string;
  supplierAuth0OrgIds: Readonly<{
    greenline: string;
    suncrest: string;
    orchard: string;
  }>;
}>;

type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | JsonObject;

interface JsonObject {
  readonly [key: string]: Json;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Readonly<Record<string, Json>>)[key],
        )}`,
    )
    .join(",")}}`;
}

function validateConfig(config: DemoSeedConfig): void {
  const ids = [
    ["buyerAuth0OrgId", config.buyerAuth0OrgId],
    ["supplierAuth0OrgIds.greenline", config.supplierAuth0OrgIds.greenline],
    ["supplierAuth0OrgIds.suncrest", config.supplierAuth0OrgIds.suncrest],
    ["supplierAuth0OrgIds.orchard", config.supplierAuth0OrgIds.orchard],
  ] as const;

  for (const [name, value] of ids) {
    if (!value || value !== value.trim() || value.length > 128)
      throw new TypeError(`${name} must be a non-empty Auth0 organization ID`);
  }
  if (new Set(ids.map(([, value]) => value)).size !== ids.length)
    throw new TypeError("Auth0 organization IDs must be unique");
}

export async function seedDemoDatabase(
  database: Database,
  config: DemoSeedConfig,
): Promise<Readonly<{ policyHash: string }>> {
  validateConfig(config);

  const policy = {
    allowedCategories: ["produce"],
    allowedDeliveryLocationIds: [DELIVERY_LOCATION_ID],
    allowedSupplierOrgIds: SUPPLIERS.map(({ id }) => id).sort(),
    autonomousOrderLimitMinor: 25_000,
    budgetWindow: {
      end: VALID_UNTIL,
      limitMinor: 500_000,
      start: CREATED_AT,
    },
    currency: "USD",
    hardExceptionLimitMinor: 100_000,
  } as const;
  const policyJson = canonicalJson(policy);
  const policyHash = createHash("sha256").update(policyJson).digest("hex");

  await withImmediateTransaction(database, async (transaction) => {
    const upsertOrganization = `
      INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        auth0_org_id = excluded.auth0_org_id,
        name = excluded.name,
        kind = excluded.kind,
        created_at = excluded.created_at
    `;
    await transaction.run(
      upsertOrganization,
      BUYER_ID,
      config.buyerAuth0OrgId,
      "Juniper Table Group",
      "buyer",
      CREATED_AT,
    );
    for (const supplier of SUPPLIERS) {
      await transaction.run(
        upsertOrganization,
        supplier.id,
        config.supplierAuth0OrgIds[supplier.key],
        supplier.name,
        "supplier",
        CREATED_AT,
      );
    }

    const upsertOffer = `
      INSERT INTO catalog_items (
        id, supplier_organization_id, sku, product_key, category, unit,
        unit_price, currency, advisory_quantity, valid_from, valid_until,
        display_name, description, active, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'produce', 'case', ?, 'USD', 200, ?, ?,
        ?, 'Registered demo inventory offer', 1, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        supplier_organization_id = excluded.supplier_organization_id,
        sku = excluded.sku,
        product_key = excluded.product_key,
        category = excluded.category,
        unit = excluded.unit,
        unit_price = excluded.unit_price,
        currency = excluded.currency,
        advisory_quantity = excluded.advisory_quantity,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        display_name = excluded.display_name,
        description = excluded.description,
        active = excluded.active,
        version = excluded.version,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `;
    for (const [supplierIndex, supplier] of SUPPLIERS.entries()) {
      for (const product of PRODUCTS) {
        await transaction.run(
          upsertOffer,
          `offer-${supplier.key}-${product.key}`,
          supplier.id,
          `${supplier.key.slice(0, 2).toUpperCase()}-${product.sku}-CASE`,
          product.key,
          product.prices[supplierIndex],
          CREATED_AT,
          VALID_UNTIL,
          `${product.name} — ${supplier.name}`,
          CREATED_AT,
          CREATED_AT,
        );
      }
    }

    await transaction.run(`
      INSERT INTO mandates (
        id, buyer_organization_id, version, state, valid_from, valid_until,
        policy_json, schema_version, policy_hash, created_by_subject, created_at
      ) VALUES (
        'mandate-juniper-1', ?, 1, 'active', ?, ?, ?, 1, ?,
        'system:demo-seed', ?
      )
      ON CONFLICT(id) DO NOTHING
    `,
      BUYER_ID,
      CREATED_AT,
      VALID_UNTIL,
      policyJson,
      policyHash,
      CREATED_AT,
    );
    const storedMandate = await transaction.get(`
      SELECT buyer_organization_id, version, state, valid_from, valid_until,
        policy_json, schema_version, policy_hash, created_by_subject, created_at
      FROM mandates WHERE id = 'mandate-juniper-1'
    `);
    if (
      JSON.stringify(storedMandate) !== JSON.stringify({
        buyer_organization_id: BUYER_ID,
        version: 1,
        state: "active",
        valid_from: CREATED_AT,
        valid_until: VALID_UNTIL,
        policy_json: policyJson,
        schema_version: 1,
        policy_hash: policyHash,
        created_by_subject: "system:demo-seed",
        created_at: CREATED_AT,
      })
    ) {
      throw new Error("Existing demo mandate does not match the seed");
    }
  });

  const demoOrder = await createOrder(
    database,
    Object.freeze({
      subject: "buyer-agent:demo-seed",
      organizationId: config.buyerAuth0OrgId,
      actorType: "buyer_agent",
      scopes: Object.freeze(["orders:create"]),
    }),
    {
      productKey: "hass-avocado",
      unit: "case",
      quantity: 18,
      deliveryLocationId: DELIVERY_LOCATION_ID,
    },
    "00000000-0000-4000-8000-000000000384",
    "demo-seed-order",
  );
  if (
    demoOrder.kind !== "order"
    || (!demoOrder.replayed && demoOrder.order.status !== "awaiting_approval")
  ) throw new Error("Demo order did not require approval");

  return Object.freeze({ policyHash });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runCli(): Promise<void> {
  const config: DemoSeedConfig = {
    buyerAuth0OrgId: requiredEnvironment("AUTH0_BUYER_ORG_ID"),
    supplierAuth0OrgIds: {
      greenline: requiredEnvironment("AUTH0_GREENLINE_ORG_ID"),
      suncrest: requiredEnvironment("AUTH0_SUNCREST_ORG_ID"),
      orchard: requiredEnvironment("AUTH0_ORCHARD_ORG_ID"),
    },
  };
  await withDatabase(async (database) => {
    const { policyHash } = await seedDemoDatabase(database, config);
    console.log(`Seeded Mandate demo data (${policyHash})`);
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `Seed failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
