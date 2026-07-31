import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "../src/auth/context.ts";
import { initializeDatabase } from "../src/db.ts";
import {
  initiateOrderPayment,
  type PaymentIntentsClient,
} from "../src/payments/stripe.ts";
import { createMandate } from "../src/procurement/mandates.ts";
import { createOrder } from "../src/procurement/orders.ts";

const now = new Date("2026-07-30T12:00:00.000Z");
const validFrom = "2026-01-01T00:00:00.000Z";
const validUntil = "2027-01-01T00:00:00.000Z";
const buyer: ActorContext = Object.freeze({
  organizationId: "org_buyer",
  actorType: "buyer_agent",
  scopes: Object.freeze(["orders:create"]),
  subject: "buyer-agent@test",
});

async function setupDatabase() {
  const database = initializeDatabase(":memory:");
  const organization = database.prepare(`
    INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  organization.run("buyer", "org_buyer", "Buyer", "buyer", now.toISOString());
  organization.run(
    "supplier", "org_supplier", "Supplier", "supplier", now.toISOString(),
  );
  database.prepare(`
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (
      'offer', 'supplier', 'sku', 'avocado', 'produce', 'case', 1000, 'USD',
      20, ?, ?, 'Avocados', ?, ?
    )
  `).run(validFrom, validUntil, now.toISOString(), now.toISOString());
  await createMandate(
    database,
    Object.freeze({
      organizationId: "org_buyer",
      actorType: "human",
      scopes: Object.freeze(["mandates:write"]),
      subject: "approver@test",
    }),
    {
      validFrom,
      validUntil,
      policy: {
        currency: "USD",
        autonomousOrderLimitMinor: 20_000,
        hardExceptionLimitMinor: 30_000,
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
  return database;
}

test("Stripe initiation creates once, persists before confirm, and safely replays", async () => {
  const database = await setupDatabase();
  const created = await createOrder(
    database,
    buyer,
    {
      productKey: "avocado",
      unit: "case",
      quantity: 10,
      deliveryLocationId: "kitchen",
    },
    "00000000-0000-4000-8000-000000000501",
    "order-request",
    now,
  );
  if (created.kind !== "order") throw new Error("Expected an order");

  const calls: string[] = [];
  const intent = {
    id: "pi_test_order",
    amount: 10_000,
    currency: "usd",
    livemode: false,
    metadata: { order_id: created.order.id },
    status: "succeeded",
    lastResponse: { requestId: "req_test" },
  };
  const client: PaymentIntentsClient = {
    create: async (params, options) => {
      calls.push(`create:${options.idempotencyKey}`);
      assert.equal(params.payment_method, "pm_card_visa");
      assert.deepEqual(params.metadata, { order_id: created.order.id });
      return intent;
    },
    confirm: async (id, params, options) => {
      calls.push(`confirm:${options.idempotencyKey}`);
      assert.equal(id, intent.id);
      assert.deepEqual(params, {
        error_on_requires_action: true,
        off_session: true,
      });
      assert.equal(
        (await database.get(
          "SELECT stripe_payment_intent_id FROM orders WHERE id = ?",
          created.order.id,
        ))?.stripe_payment_intent_id,
        intent.id,
      );
      return intent;
    },
  };
  const previousMethod = process.env.STRIPE_PAYMENT_METHOD_ID;
  process.env.STRIPE_PAYMENT_METHOD_ID = "pm_card_visa";
  try {
    await initiateOrderPayment(
      database, created.order.id, "payment-request-1", client, now,
    );
    await initiateOrderPayment(
      database, created.order.id, "payment-request-2", client, now,
    );
  } finally {
    if (previousMethod === undefined)
      delete process.env.STRIPE_PAYMENT_METHOD_ID;
    else process.env.STRIPE_PAYMENT_METHOD_ID = previousMethod;
  }

  assert.deepEqual(calls, [
    `create:order:${created.order.id}:create`,
    `confirm:order:${created.order.id}:confirm`,
    `confirm:order:${created.order.id}:confirm`,
  ]);
  const row = await database.get(`
    SELECT status, stripe_create_started_at, stripe_payment_intent_id
    FROM orders WHERE id = ?
  `, created.order.id);
  assert.equal(row?.status, "payment_pending");
  assert.equal(row?.stripe_create_started_at, now.toISOString());
  assert.equal(row?.stripe_payment_intent_id, intent.id);
  const payloads = (await database.all(`
    SELECT payload_json FROM audit_events
    WHERE aggregate_id = ? AND event_type LIKE 'stripe.%'
  `, created.order.id)).map(({ payload_json }) => String(payload_json));
  assert.equal(payloads.some((payload) => payload.includes("pm_card_visa")), false);
  await database.close();
});
