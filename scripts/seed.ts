import { closeDb, getDb, migrate } from "../src/db";
import { seedRegisteredSku } from "../src/catalog/catalog";
import { newId, nowIso } from "../src/lib/ids";

function upsertOrg(input: {
  auth0OrgId: string;
  name: string;
  kind: "buyer" | "supplier";
  stripeCustomerId?: string;
}): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM organizations WHERE auth0_org_id = ?`)
    .get(input.auth0OrgId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId("org");
  db.prepare(
    `INSERT INTO organizations (id, auth0_org_id, name, kind, stripe_customer_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.auth0OrgId,
    input.name,
    input.kind,
    input.stripeCustomerId ?? null,
    nowIso(),
  );
  return id;
}

function mapClient(clientId: string, organizationId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO m2m_client_org_map (client_id, organization_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(clientId, organizationId, nowIso());
}

migrate(getDb());

const buyerId = upsertOrg({
  auth0OrgId: process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer",
  name: "Demo Restaurant",
  kind: "buyer",
  stripeCustomerId: process.env.SEED_STRIPE_CUSTOMER_ID,
});
const supplierA = upsertOrg({
  auth0OrgId: process.env.SEED_SUPPLIER_A_AUTH0_ORG_ID ?? "org_supplier_a",
  name: "Green Valley Produce",
  kind: "supplier",
});
const supplierB = upsertOrg({
  auth0OrgId: process.env.SEED_SUPPLIER_B_AUTH0_ORG_ID ?? "org_supplier_b",
  name: "Coastal Fresh Farms",
  kind: "supplier",
});

mapClient(process.env.SEED_BUYER_CLIENT_ID ?? "buyer_client_id", buyerId);
mapClient(process.env.SEED_SUPPLIER_A_CLIENT_ID ?? "supplier_a_client_id", supplierA);
mapClient(process.env.SEED_SUPPLIER_B_CLIENT_ID ?? "supplier_b_client_id", supplierB);

const db = getDb();
const from = new Date(Date.now() - 60_000).toISOString();
const until = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

const catalogSeed: Array<{
  orgId: string;
  sku: string;
  productKey: string;
  price: number;
  name: string;
}> = [
  { orgId: supplierA, sku: "AVO-CASE-48", productKey: "avocado", price: 4200, name: "Hass Avocados (48ct case)" },
  { orgId: supplierB, sku: "AVO-CASE-48", productKey: "avocado", price: 3900, name: "Hass Avocados (48ct case)" },
  { orgId: supplierA, sku: "TOM-CASE-25", productKey: "tomato", price: 2800, name: "Roma Tomatoes (25lb case)" },
  { orgId: supplierB, sku: "TOM-CASE-25", productKey: "tomato", price: 2500, name: "Roma Tomatoes (25lb case)" },
  { orgId: supplierA, sku: "LET-CASE-12", productKey: "lettuce", price: 1800, name: "Butter Lettuce (12ct case)" },
  { orgId: supplierB, sku: "LET-CASE-12", productKey: "lettuce", price: 1600, name: "Butter Lettuce (12ct case)" },
];

for (const row of catalogSeed) {
  const exists = db
    .prepare(`SELECT id FROM catalog_items WHERE supplier_org_id = ? AND sku = ?`)
    .get(row.orgId, row.sku);
  if (!exists) {
    seedRegisteredSku(db, {
      supplierOrgId: row.orgId,
      sku: row.sku,
      productKey: row.productKey,
      category: "produce",
      unit: "case",
      unitPriceMinor: row.price,
      currency: "USD",
      advisoryQuantity: 100,
      validFrom: from,
      validUntil: until,
      displayName: row.name,
    });
  }
}

console.log(
  JSON.stringify(
    {
      buyerId,
      supplierA,
      supplierB,
      product_key: "avocado",
      unit: "case",
    },
    null,
    2,
  ),
);

closeDb();
