import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "../src/auth/context.ts";
import { initializeDatabase } from "../src/db.ts";
import {
  createWalletCheckout,
  type CheckoutSessionsClient,
} from "../src/payments/stripe.ts";
import {
  createWalletTopUp,
  settleOrderFromWallet,
} from "../src/payments/wallet.ts";
import { createMandate } from "../src/procurement/mandates.ts";
import { createOrder } from "../src/procurement/orders.ts";
import { reconcileStripeEvent } from "../src/webhooks/stripe.ts";

test("Stripe webhook credits wallet once and an order debits it atomically", async () => {
  const database = initializeDatabase(":memory:");
  const now = new Date("2026-07-30T12:00:00.000Z");
  await database.run(`
    INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
    VALUES ('buyer', 'org_buyer', 'Buyer', 'buyer', ?),
      ('supplier', 'org_supplier', 'Supplier', 'supplier', ?)
  `, now.toISOString(), now.toISOString());
  await database.run(`
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (
      'offer', 'supplier', 'sku', 'lime', 'produce', 'case', 1000, 'USD', 20,
      '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'Limes', ?, ?
    )
  `, now.toISOString(), now.toISOString());
  const human: ActorContext = Object.freeze({
    organizationId: "org_buyer",
    actorType: "human",
    scopes: Object.freeze(["mandates:write", "approvals:read"]),
    subject: "human@test",
  });
  await createMandate(database, human, {
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    policy: {
      currency: "USD",
      autonomousOrderLimitMinor: 20_000,
      hardExceptionLimitMinor: 30_000,
      budgetWindow: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2027-01-01T00:00:00.000Z",
        limitMinor: 100_000,
      },
      allowedSupplierOrgIds: ["supplier"],
      allowedCategories: ["produce"],
      allowedDeliveryLocationIds: ["kitchen"],
    },
  }, "mandate", now);
  const topup = await createWalletTopUp(
    database,
    human,
    20_000,
    "topup",
    now,
  );
  const checkout: CheckoutSessionsClient = {
    create: async (params, options) => {
      assert.equal(params.mode, "payment");
      assert.equal(params.payment_intent_data?.metadata?.wallet_topup_id, topup.id);
      assert.equal(options.idempotencyKey, `wallet-topup:${topup.id}:checkout`);
      return {
        id: "cs_test_wallet",
        url: "https://checkout.stripe.com/test",
        livemode: false,
        amount_total: 20_000,
        currency: "usd",
        metadata: { wallet_topup_id: topup.id },
      };
    },
  };
  assert.equal(
    await createWalletCheckout(
      database,
      topup,
      "checkout",
      "http://localhost:3000",
      checkout,
      now,
    ),
    "https://checkout.stripe.com/test",
  );
  const event = Object.freeze({
    id: "evt_wallet",
    type: "payment_intent.succeeded" as const,
    paymentIntentId: "pi_wallet",
    orderId: null,
    walletTopUpId: topup.id,
    amountMinor: 20_000,
    currency: "USD",
    livemode: false,
  });
  assert.equal(
    (await reconcileStripeEvent(database, event, "webhook", now)).outcome,
    "processed",
  );
  assert.equal(
    (await reconcileStripeEvent(database, event, "duplicate", now)).outcome,
    "duplicate",
  );

  const order = await createOrder(
    database,
    Object.freeze({
      organizationId: "org_buyer",
      actorType: "buyer_agent",
      scopes: Object.freeze(["orders:create"]),
      subject: "agent@test",
    }),
    {
      productKey: "lime",
      unit: "case",
      quantity: 10,
      deliveryLocationId: "kitchen",
    },
    "00000000-0000-4000-8000-000000009001",
    "order",
    now,
  );
  if (order.kind !== "order") throw new Error("Expected order");
  await settleOrderFromWallet(database, order.order.id, "wallet-debit", now);

  assert.equal((await database.get(
    "SELECT balance FROM wallet_accounts WHERE organization_id = 'buyer'",
  ))?.balance, 10_000);
  assert.equal((await database.get(
    "SELECT status FROM orders WHERE id = ?",
    order.order.id,
  ))?.status, "paid");
  assert.equal((await database.get(
    "SELECT count(*) AS count FROM wallet_transactions",
  ))?.count, 2);
  assert.equal((await database.get(
    "SELECT stripe_payment_intent_id FROM wallet_topups WHERE id = ?",
    topup.id,
  ))?.stripe_payment_intent_id, "pi_wallet");
  await database.close();
});
