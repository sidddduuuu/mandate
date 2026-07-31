/**
 * Seeds an active buyer mandate + one awaiting_approval avocado order for the UI demo.
 */
import { randomUUID } from "crypto";
import { closeDb, getDb, migrate } from "../src/db";
import { resetConfigCache } from "../src/lib/config";
import { createMandateVersion } from "../src/procurement/mandates";
import { createOrder } from "../src/procurement/orders";
import { createMemoryStripeAdapter } from "../src/payments/stripe";
import type { ActorContext } from "../src/auth/context";

process.env.AUTH_TEST_MODE = "1";
resetConfigCache();
migrate(getDb());

const db = getDb();
const buyer = db
  .prepare(`SELECT id, auth0_org_id FROM organizations WHERE kind = 'buyer' LIMIT 1`)
  .get() as { id: string; auth0_org_id: string } | undefined;
const suppliers = db
  .prepare(`SELECT id FROM organizations WHERE kind = 'supplier' ORDER BY name`)
  .all() as Array<{ id: string }>;

if (!buyer || suppliers.length < 1) {
  console.error("Run npm run seed first");
  process.exit(1);
}

const buyerOrg = buyer;
const from = new Date(Date.now() - 60_000).toISOString();
const until = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

const human: ActorContext = {
  actorType: "human",
  subject: "human-approver@mandate.local",
  organizationId: buyerOrg.id,
  auth0OrgId: buyerOrg.auth0_org_id,
  scopes: new Set(),
  permissions: new Set(["mandates:write", "approvals:read", "approvals:decide", "orders:read"]),
};

const buyerAgent: ActorContext = {
  actorType: "agent",
  subject: "buyer-agent@mandate.local",
  organizationId: buyerOrg.id,
  auth0OrgId: buyerOrg.auth0_org_id,
  scopes: new Set(["orders:create", "orders:read", "offers:read"]),
  permissions: new Set(),
};

const active = db
  .prepare(`SELECT id FROM mandates WHERE buyer_org_id = ? AND status = 'active'`)
  .get(buyerOrg.id);
if (!active) {
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
      allowed_supplier_org_ids: suppliers.map((s) => s.id),
      allowed_categories: ["produce"],
      allowed_delivery_location_ids: ["kitchen-1"],
      valid_from: from,
      valid_until: until,
    },
    "seed-demo-mandate",
  );
}

async function main(): Promise<void> {
  const pending = db
    .prepare(
      `SELECT id FROM orders WHERE buyer_org_id = ? AND status = 'awaiting_approval' LIMIT 1`,
    )
    .get(buyerOrg.id) as { id: string } | undefined;

  let orderId = pending?.id;
  if (!orderId) {
    const stripe = createMemoryStripeAdapter();
    const { order } = await createOrder(
      db,
      buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "seed-demo-order",
      stripe,
    );
    orderId = order.id;
  }

  console.log(
    JSON.stringify(
      {
        buyer_auth0_org_id: buyerOrg.auth0_org_id,
        awaiting_approval_order_id: orderId,
        login: `/auth/login?organization=${buyerOrg.auth0_org_id}`,
      },
      null,
      2,
    ),
  );

  closeDb();
}

main().catch((err) => {
  console.error(err);
  closeDb();
  process.exit(1);
});
