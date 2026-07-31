/**
 * Local demo driver (no HTTP server required).
 * Uses AUTH_TEST_MODE tokens and in-memory Stripe.
 */
import { randomUUID } from "crypto";
import { resetDbForTests, closeDb } from "../src/db";
import { resetConfigCache } from "../src/lib/config";
import { encodeSessionCookie, mintTestAgentToken } from "../src/auth/context";
import { seedRegisteredSku } from "../src/catalog/catalog";
import { createMandateVersion } from "../src/procurement/mandates";
import { createOrder, decideApproval, handleStripeWebhook } from "../src/procurement/orders";
import { createMemoryStripeAdapter } from "../src/payments/stripe";
import { newId, nowIso } from "../src/lib/ids";
import type { ActorContext } from "../src/auth/context";

process.env.AUTH_TEST_MODE = "1";
process.env.DATABASE_PATH = "./data/demo.db";
resetConfigCache();

const db = resetDbForTests("./data/demo.db");
const stripe = createMemoryStripeAdapter();

const buyerOrg = newId("org");
const supplierA = newId("org");
const supplierB = newId("org");
const now = nowIso();

db.prepare(
  `INSERT INTO organizations (id, auth0_org_id, name, kind, stripe_customer_id, created_at)
   VALUES (?, 'org_buyer', 'Restaurant', 'buyer', 'cus_demo', ?),
          (?, 'org_supplier_a', 'Supplier A', 'supplier', NULL, ?),
          (?, 'org_supplier_b', 'Supplier B', 'supplier', NULL, ?)`,
).run(buyerOrg, now, supplierA, now, supplierB, now);

const from = new Date(Date.now() - 60_000).toISOString();
const until = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

seedRegisteredSku(db, {
  supplierOrgId: supplierA,
  sku: "AVO-CASE-48",
  productKey: "avocado",
  category: "produce",
  unit: "case",
  unitPriceMinor: 4200,
  currency: "USD",
  advisoryQuantity: 50,
  validFrom: from,
  validUntil: until,
  displayName: "Avocados A",
});
seedRegisteredSku(db, {
  supplierOrgId: supplierB,
  sku: "AVO-CASE-48",
  productKey: "avocado",
  category: "produce",
  unit: "case",
  unitPriceMinor: 3900,
  currency: "USD",
  advisoryQuantity: 50,
  validFrom: from,
  validUntil: until,
  displayName: "Avocados B",
});

const human: ActorContext = {
  actorType: "human",
  subject: "human-approver",
  organizationId: buyerOrg,
  auth0OrgId: "org_buyer",
  scopes: new Set(),
  permissions: new Set(["mandates:write", "approvals:read", "approvals:decide", "orders:read"]),
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
    allowed_supplier_org_ids: [supplierA, supplierB],
    allowed_categories: ["produce"],
    allowed_delivery_location_ids: ["kitchen-1"],
    valid_from: from,
    valid_until: until,
  },
  "demo-mandate",
);

const buyer: ActorContext = {
  actorType: "agent",
  subject: "buyer-agent",
  organizationId: buyerOrg,
  auth0OrgId: "org_buyer",
  scopes: new Set(["orders:create", "orders:read", "offers:read"]),
  permissions: new Set(),
};

async function main(): Promise<void> {
  const { order, httpStatus } = await createOrder(
    db,
    buyer,
    {
      product_key: "avocado",
      unit: "case",
      quantity: 2,
      delivery_location_id: "kitchen-1",
    },
    randomUUID(),
    "demo-order",
    stripe,
  );

  console.log("order_created", {
    httpStatus,
    status: order.status,
    total: order.total_minor,
    supplier: order.supplier_org_id,
  });

  const approved = await decideApproval(
    db,
    human,
    order.id,
    { decision: "approve", reason: "Weekly restock" },
    "demo-approve",
    stripe,
  );
  console.log("approved", { status: approved.status, pi: approved.stripe_payment_intent_id });

  handleStripeWebhook(
    db,
    {
      id: "evt_demo_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: approved.stripe_payment_intent_id!,
          amount: approved.total_minor,
          currency: "usd",
          metadata: { order_id: approved.id },
        },
      },
    },
    "demo-webhook",
  );

  const paid = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(approved.id);
  console.log("final", paid);

  const token = await mintTestAgentToken({
    sub: "buyer-agent",
    org_id: "org_buyer",
    scope: "orders:create orders:read",
    client_id: "buyer-client",
  });
  const session = encodeSessionCookie({
    sub: "human-approver",
    org_id: "org_buyer",
    permissions: ["approvals:decide"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  console.log("helpers_ok", { token_len: token.length, session_len: session.length });

  closeDb();
}

main().catch((err) => {
  console.error(err);
  closeDb();
  process.exit(1);
});
