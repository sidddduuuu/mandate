import path from "path";
import { resetDbForTests, type Db } from "../src/db";
import { resetConfigCache } from "../src/lib/config";
import { resetRateLimits } from "../src/lib/rate-limit";
import { seedRegisteredSku } from "../src/catalog/catalog";
import { createMandateVersion } from "../src/procurement/mandates";
import { createMemoryStripeAdapter } from "../src/payments/stripe";
import { newId, nowIso } from "../src/lib/ids";
import type { ActorContext } from "../src/auth/context";

export type DemoFixture = {
  db: Db;
  stripe: ReturnType<typeof createMemoryStripeAdapter>;
  buyerOrgId: string;
  supplierAId: string;
  supplierBId: string;
  human: ActorContext;
  buyerAgent: ActorContext;
  supplierAgent: ActorContext;
  from: string;
  until: string;
};

export function setupFixture(name: string): DemoFixture {
  process.env.AUTH_TEST_MODE = "1";
  process.env.DATABASE_PATH = path.resolve(`/tmp/mandate-${name}-${process.pid}.db`);
  process.env.AUTH0_M2M_CLIENT_ORG_MAP =
    "buyer-client=org_buyer,supplier-a-client=org_supplier_a,supplier-b-client=org_supplier_b";
  resetConfigCache();
  resetRateLimits();
  const db = resetDbForTests(process.env.DATABASE_PATH);
  const stripe = createMemoryStripeAdapter();
  const now = nowIso();
  const from = new Date(Date.now() - 60_000).toISOString();
  const until = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

  const buyerOrgId = newId("org");
  const supplierAId = newId("org");
  const supplierBId = newId("org");

  db.prepare(
    `INSERT INTO organizations (id, auth0_org_id, name, kind, stripe_customer_id, created_at)
     VALUES (?, 'org_buyer', 'Restaurant', 'buyer', 'cus_test', ?),
            (?, 'org_supplier_a', 'Supplier A', 'supplier', NULL, ?),
            (?, 'org_supplier_b', 'Supplier B', 'supplier', NULL, ?)`,
  ).run(buyerOrgId, now, supplierAId, now, supplierBId, now);

  seedRegisteredSku(db, {
    supplierOrgId: supplierAId,
    sku: "AVO-CASE-48",
    productKey: "avocado",
    category: "produce",
    unit: "case",
    unitPriceMinor: 4200,
    currency: "USD",
    advisoryQuantity: 100,
    validFrom: from,
    validUntil: until,
    displayName: "Avocados A",
  });
  seedRegisteredSku(db, {
    supplierOrgId: supplierBId,
    sku: "AVO-CASE-48",
    productKey: "avocado",
    category: "produce",
    unit: "case",
    unitPriceMinor: 3900,
    currency: "USD",
    advisoryQuantity: 100,
    validFrom: from,
    validUntil: until,
    displayName: "Avocados B",
  });

  const human: ActorContext = {
    actorType: "human",
    subject: "human-approver",
    organizationId: buyerOrgId,
    auth0OrgId: "org_buyer",
    scopes: new Set(),
    permissions: new Set([
      "mandates:write",
      "approvals:read",
      "approvals:decide",
      "orders:read",
    ]),
  };

  createMandateVersion(
    db,
    human,
    {
      currency: "USD",
      autonomous_order_limit_minor: 5000,
      hard_exception_limit_minor: 50_000,
      budget_window_start: from,
      budget_window_end: until,
      budget_limit_minor: 100_000,
      allowed_supplier_org_ids: [supplierAId, supplierBId],
      allowed_categories: ["produce"],
      allowed_delivery_location_ids: ["kitchen-1"],
      valid_from: from,
      valid_until: until,
    },
    "seed-mandate",
  );

  return {
    db,
    stripe,
    buyerOrgId,
    supplierAId,
    supplierBId,
    human,
    buyerAgent: {
      actorType: "agent",
      subject: "buyer-agent",
      organizationId: buyerOrgId,
      auth0OrgId: "org_buyer",
      scopes: new Set(["orders:create", "orders:read", "offers:read"]),
      permissions: new Set(),
    },
    supplierAgent: {
      actorType: "agent",
      subject: "supplier-a-agent",
      organizationId: supplierAId,
      auth0OrgId: "org_supplier_a",
      scopes: new Set(["catalog:write"]),
      permissions: new Set(),
    },
    from,
    until,
  };
}
