import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import type { ActorContext } from "../src/auth/context.ts";
import { initializeDatabase } from "../src/db.ts";
import { ApiError } from "../src/http.ts";
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
    chargeId: "ch_wallet",
    orderId: null,
    walletTopUpId: topup.id,
    amountMinor: 20_000,
    currency: "USD",
    livemode: false,
  });
  assert.equal((await reconcileStripeEvent(database, Object.freeze({
    ...event,
    id: "evt_wallet_failed_attempt",
    type: "payment_intent.payment_failed" as const,
    chargeId: null,
  }), "failed-attempt", now)).orderStatus, "failed");
  assert.equal(
    (await reconcileStripeEvent(database, event, "webhook", now)).outcome,
    "processed",
  );
  assert.equal(
    (await reconcileStripeEvent(database, event, "duplicate", now)).outcome,
    "duplicate",
  );
  assert.equal((await reconcileStripeEvent(database, Object.freeze({
    ...event,
    id: "evt_wallet_replayed_success",
  }), "replayed-success", now)).outcome, "processed");

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
    "SELECT status FROM offer_reservations WHERE order_id = ?",
    order.order.id,
  ))?.status, "settled");
  assert.equal((await database.get(
    "SELECT count(*) AS count FROM wallet_transactions",
  ))?.count, 2);
  assert.equal((await database.get(
    "SELECT stripe_payment_intent_id FROM wallet_topups WHERE id = ?",
    topup.id,
  ))?.stripe_payment_intent_id, "pi_wallet");
  const lot = await database.get(`
    SELECT stripe_payment_intent_id, stripe_charge_id, original_amount,
      available_amount, status
    FROM wallet_funding_lots WHERE wallet_topup_id = ?
  `, topup.id);
  assert.equal(lot?.stripe_payment_intent_id, "pi_wallet");
  assert.equal(lot?.stripe_charge_id, "ch_wallet");
  assert.equal(lot?.original_amount, 20_000);
  assert.equal(lot?.available_amount, 10_000);
  assert.equal(lot?.status, "available");
  const allocation = await database.get(`
    SELECT allocation.amount, lot.stripe_charge_id
    FROM wallet_funding_allocations allocation
    JOIN wallet_funding_lots lot ON lot.id = allocation.funding_lot_id
    WHERE allocation.order_id = ?
  `, order.order.id);
  assert.equal(allocation?.amount, 10_000);
  assert.equal(allocation?.stripe_charge_id, "ch_wallet");
  assert.throws(() => database.prepare(`
    UPDATE wallet_funding_lots SET stripe_charge_id = 'ch_changed'
    WHERE wallet_topup_id = ?
  `).run(topup.id), /immutable/);

  await database.run(`
    UPDATE wallet_funding_lots SET status = 'disputed', updated_at = ?
    WHERE wallet_topup_id = ?
  `, new Date("2026-07-30T12:01:00.000Z").toISOString(), topup.id);
  const second = await createOrder(
    database,
    Object.freeze({
      organizationId: "org_buyer",
      actorType: "buyer_agent",
      scopes: Object.freeze(["orders:create"]),
      subject: "agent-2@test",
    }),
    {
      productKey: "lime",
      unit: "case",
      quantity: 5,
      deliveryLocationId: "kitchen",
    },
    "00000000-0000-4000-8000-000000009002",
    "order-2",
    now,
  );
  if (second.kind !== "order") throw new Error("Expected second order");
  await assert.rejects(
    settleOrderFromWallet(database, second.order.id, "wallet-debit-2", now),
    (error: unknown) =>
      error instanceof ApiError && error.code === "WALLET_FUNDS_UNVERIFIED",
  );
  await database.close();
});

test("concurrent wallet allocations cannot exceed Stripe-funded value", async (context) => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const directory = mkdtempSync(join(tmpdir(), "mandate-wallet-"));
  const databasePath = join(directory, "wallet.sqlite");
  const database = initializeDatabase(databasePath);
  context.after(() => rmSync(directory, { force: true, recursive: true }));
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
    scopes: Object.freeze(["mandates:write", "orders:read"]),
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
  const topup = await createWalletTopUp(database, human, 15_000, "topup", now);
  await reconcileStripeEvent(database, Object.freeze({
    id: "evt_concurrent_wallet",
    type: "payment_intent.succeeded" as const,
    paymentIntentId: "pi_concurrent_wallet",
    chargeId: "ch_concurrent_wallet",
    orderId: null,
    walletTopUpId: topup.id,
    amountMinor: 15_000,
    currency: "USD",
    livemode: false,
  }), "webhook", now);
  const orders = [];
  for (const sequence of [1, 2]) {
    orders.push(await createOrder(
      database,
      Object.freeze({
        organizationId: "org_buyer",
        actorType: "buyer_agent" as const,
        scopes: Object.freeze(["orders:create"]),
        subject: `agent-${sequence}@test`,
      }),
      {
        productKey: "lime",
        unit: "case",
        quantity: 10,
        deliveryLocationId: "kitchen",
      },
      `00000000-0000-4000-8000-00000000910${sequence}`,
      `order-${sequence}`,
      now,
    ));
  }
  const orderIds = orders.map((order) => {
    if (order.kind !== "order") throw new Error("Expected order");
    return order.order.id;
  });
  database.close();

  const workers = orderIds.map((orderId, index) => new Worker(
    new URL("./wallet-settle-worker.ts", import.meta.url),
    { workerData: {
      databasePath,
      orderId,
      requestId: `settle-${index}`,
      now: now.toISOString(),
    } },
  ));
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const results = Promise.all(workers.map((worker) => once(worker, "message")));
  workers.forEach((worker) => worker.postMessage("settle"));
  const messages = (await results).map(([message]) =>
    message as { outcome?: string; code?: string }
  );
  assert.deepEqual(messages.map(({ outcome }) => outcome).sort(), ["paid", undefined].sort());
  assert.equal(messages.filter(({ code }) => code === "WALLET_INSUFFICIENT_FUNDS").length, 1);

  const verify = initializeDatabase(databasePath);
  assert.equal((await verify.get(
    "SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_funding_allocations",
  ))?.amount, 10_000);
  assert.equal((await verify.get(
    "SELECT balance FROM wallet_accounts WHERE organization_id = 'buyer'",
  ))?.balance, 5_000);
  verify.close();
});
