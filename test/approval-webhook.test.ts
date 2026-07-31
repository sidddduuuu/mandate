import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

import type {
  ActorContext,
  ActorType,
} from "../src/auth/context.ts";
import {
  initializeDatabase,
  type TestDatabase,
} from "../src/db.ts";
import { ApiError } from "../src/http.ts";
import {
  decideApproval,
  getApprovalDecision,
  listPendingApprovals,
} from "../src/procurement/approvals.ts";
import { createMandate } from "../src/procurement/mandates.ts";
import { createOrder } from "../src/procurement/orders.ts";
import {
  paymentEvent,
  reconcileStripeEvent,
  verifyStripeWebhook,
  type PaymentEvent,
} from "../src/webhooks/stripe.ts";

const now = new Date("2026-07-30T12:00:00.000Z");
const validFrom = "2026-01-01T00:00:00.000Z";
const validUntil = "2027-01-01T00:00:00.000Z";

function actor(
  organizationId: string,
  actorType: ActorType,
  scopes: readonly string[],
  subject = `${actorType}@test`,
): ActorContext {
  return Object.freeze({
    organizationId,
    actorType,
    scopes: Object.freeze([...scopes]),
    subject,
  });
}

const buyer = actor(
  "org_buyer",
  "buyer_agent",
  ["orders:create"],
  "buyer-agent",
);
const approver = actor(
  "org_buyer",
  "human",
  ["approvals:read", "approvals:decide"],
  "human-approver",
);

async function setup(): Promise<
  Readonly<{ database: TestDatabase; orderId: string }>
> {
  const database = initializeDatabase(":memory:");
  const organization = database.prepare(`
    INSERT INTO organizations (
      id, auth0_org_id, name, kind, stripe_customer_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  organization.run(
    "buyer",
    "org_buyer",
    "Buyer",
    "buyer",
    "cus_test",
    now.toISOString(),
  );
  organization.run(
    "buyer-2",
    "org_buyer_2",
    "Buyer 2",
    "buyer",
    null,
    now.toISOString(),
  );
  organization.run(
    "supplier",
    "org_supplier",
    "Supplier",
    "supplier",
    null,
    now.toISOString(),
  );
  database.prepare(`
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (
      'offer', 'supplier', 'avo', 'hass-avocado', 'produce', 'case',
      1000, 'USD', 100, ?, ?, 'Hass avocados', ?, ?
    )
  `).run(validFrom, validUntil, now.toISOString(), now.toISOString());
  await createMandate(
    database,
    actor("org_buyer", "human", ["mandates:write"], "mandate-admin"),
    {
      validFrom,
      validUntil,
      policy: {
        currency: "USD",
        autonomousOrderLimitMinor: 5_000,
        hardExceptionLimitMinor: 50_000,
        budgetWindow: {
          start: validFrom,
          end: validUntil,
          limitMinor: 100_000,
        },
        allowedSupplierOrgIds: ["supplier"],
        allowedCategories: ["produce"],
        allowedDeliveryLocationIds: ["kitchen"],
      },
    },
    "mandate-request",
    now,
  );
  const created = await createOrder(
    database,
    buyer,
    {
      productKey: "hass-avocado",
      unit: "case",
      quantity: 10,
      deliveryLocationId: "kitchen",
    },
    crypto.randomUUID(),
    "order-request",
    now,
  );
  if (created.kind !== "order") throw new Error("Expected an order");
  assert.equal(created.order.status, "awaiting_approval");
  return Object.freeze({ database, orderId: created.order.id });
}

test("same-tenant approval is one-time and payment-ready", async () => {
  const { database, orderId } = await setup();
  assert.deepEqual(
    (await listPendingApprovals(database, approver, now)).map(({ id }) => id),
    [orderId],
  );
  assert.deepEqual(
    await listPendingApprovals(
      database,
      actor("org_buyer_2", "human", ["approvals:read"]),
      now,
    ),
    [],
  );

  const result = await decideApproval(
    database,
    approver,
    orderId,
    { decision: "approve", reason: "Needed for service" },
    "approval-request",
    now,
  );
  assert.equal(result.approval.status, "payment_pending");
  assert.equal(result.initiatePayment, true);
  assert.equal(result.replayed, false);
  assert.equal(
    (await database.get(
      "SELECT approval_actor_subject FROM orders WHERE id = ?",
      orderId,
    ))?.approval_actor_subject,
    approver.subject,
  );
  const replay = await decideApproval(
    database,
    approver,
    orderId,
    { decision: "approve" },
    "approval-replay",
    now,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.initiatePayment, true);
  await database.close();
});

test("approval expiry and changed offers fail closed with committed states", async () => {
  const expired = await setup();
  await assert.rejects(
    decideApproval(
      expired.database,
      approver,
      expired.orderId,
      { decision: "approve" },
      "expired-request",
      new Date("2026-07-30T12:31:00.000Z"),
    ),
    (error: unknown) =>
      error instanceof ApiError && error.code === "APPROVAL_EXPIRED",
  );
  assert.equal(
    (await expired.database.get(
      "SELECT status FROM orders WHERE id = ?",
      expired.orderId,
    ))?.status,
    "expired",
  );
  await expired.database.close();

  const stale = await setup();
  await stale.database.run(`
    UPDATE catalog_items SET unit_price = 1100, version = version + 1,
      updated_at = ? WHERE id = 'offer'
  `, now.toISOString());
  await assert.rejects(
    decideApproval(
      stale.database,
      approver,
      stale.orderId,
      { decision: "approve" },
      "stale-request",
      now,
    ),
    (error: unknown) =>
      error instanceof ApiError && error.code === "APPROVAL_STALE",
  );
  assert.equal(
    (await stale.database.get(
      "SELECT status FROM orders WHERE id = ?",
      stale.orderId,
    ))?.status,
    "stale",
  );
  await stale.database.close();
});

function succeeded(
  orderId: string,
  overrides: Partial<PaymentEvent> = {},
): PaymentEvent {
  return Object.freeze({
    id: crypto.randomUUID(),
    type: "payment_intent.succeeded",
    paymentIntentId: "pi_test",
    orderId,
    amountMinor: 10_000,
    currency: "USD",
    livemode: false,
    ...overrides,
  });
}

test("signed Stripe events deduplicate and reconcile without regressions", async (context) => {
  const { database, orderId } = await setup();
  await decideApproval(
    database,
    approver,
    orderId,
    { decision: "approve" },
    "approval-request",
    now,
  );
  await database.run(`
    UPDATE orders SET stripe_create_started_at = ?,
      stripe_payment_intent_id = 'pi_test', updated_at = ? WHERE id = ?
  `, now.toISOString(), now.toISOString(), orderId);
  assert.equal(
    (await getApprovalDecision(database, approver, orderId)).status,
    "payment_pending",
  );

  const event = succeeded(orderId);
  assert.equal(
    (await reconcileStripeEvent(
      database,
      event,
      "webhook-request",
      now,
    )).orderStatus,
    "paid",
  );
  assert.equal(
    (await getApprovalDecision(database, approver, orderId)).status,
    "paid",
  );
  assert.equal(
    (await reconcileStripeEvent(
      database,
      event,
      "webhook-replay",
      now,
    )).outcome,
    "duplicate",
  );
  const failure = succeeded(orderId, {
    id: crypto.randomUUID(),
    type: "payment_intent.payment_failed",
  });
  assert.equal(
    (await reconcileStripeEvent(
      database,
      failure,
      "late-failure",
      now,
    )).outcome,
    "ignored",
  );
  assert.equal(
    (await database.get(
      "SELECT status FROM orders WHERE id = ?",
      orderId,
    ))?.status,
    "paid",
  );

  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_demo";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_demo";
  context.after(async () => {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    await database.close();
  });
  const payload = JSON.stringify({
    id: "evt_signed",
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_test",
        object: "payment_intent",
        amount: 10_000,
        currency: "usd",
        livemode: false,
        metadata: { order_id: orderId },
      },
    },
  });
  const signature = new Stripe("sk_test_demo").webhooks
    .generateTestHeaderString({
      payload,
      secret: "whsec_demo",
      timestamp: Math.floor(Date.now() / 1_000),
    });
  const verified = await verifyStripeWebhook(new Request(
    "http://localhost/api/webhooks/stripe",
    {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    },
  ));
  assert.equal(paymentEvent(verified)?.orderId, orderId);
  await assert.rejects(
    verifyStripeWebhook(new Request(
      "http://localhost/api/webhooks/stripe",
      {
        method: "POST",
        headers: { "stripe-signature": "invalid" },
        body: payload,
      },
    )),
    (error: unknown) =>
      error instanceof ApiError && error.code === "INVALID_STRIPE_SIGNATURE",
  );
});
