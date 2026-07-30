import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { closeDb } from "../src/db";
import { updateCatalog } from "../src/catalog/catalog";
import { createMandateVersion } from "../src/procurement/mandates";
import {
  createOrder,
  decideApproval,
  handleStripeWebhook,
  abandonFailedPayment,
  expireApprovals,
} from "../src/procurement/orders";
import { setupFixture, type DemoFixture } from "./helpers";
import { AppError } from "../src/lib/http";

describe("order flow", () => {
  let fx: DemoFixture;

  beforeEach(() => {
    closeDb();
    fx = setupFixture(`flow-${randomUUID()}`);
  });

  it("selects cheapest eligible offer and requires approval over autonomous limit", async () => {
    const { order, httpStatus } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "req-1",
      fx.stripe,
    );
    assert.equal(httpStatus, 202);
    assert.equal(order.status, "awaiting_approval");
    assert.equal(order.supplier_org_id, fx.supplierBId);
    assert.equal(order.total_minor, 7800);
    assert.equal(order.stripe_payment_intent_id, null);
  });

  it("approves, creates one PaymentIntent, and pays via webhook", async () => {
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "req-2",
      fx.stripe,
    );

    const approved = await decideApproval(
      fx.db,
      fx.human,
      order.id,
      { decision: "approve" },
      "req-3",
      fx.stripe,
    );
    assert.equal(approved.status, "payment_pending");
    assert.ok(approved.stripe_payment_intent_id);
    assert.equal(fx.stripe.intents.size, 1);

    handleStripeWebhook(
      fx.db,
      {
        id: "evt_1",
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
      "req-4",
    );

    const paid = fx.db.prepare(`SELECT status FROM orders WHERE id = ?`).get(order.id) as {
      status: string;
    };
    assert.equal(paid.status, "paid");

    const dup = handleStripeWebhook(
      fx.db,
      {
        id: "evt_1",
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
      "req-5",
    );
    assert.equal(dup.duplicate, true);
  });

  it("replays idempotent orders and conflicts on payload mismatch", async () => {
    const key = randomUUID();
    const body = {
      product_key: "avocado",
      unit: "case",
      quantity: 1,
      delivery_location_id: "kitchen-1",
    };
    const first = await createOrder(fx.db, fx.buyerAgent, body, key, "idemp-1", fx.stripe);
    const second = await createOrder(fx.db, fx.buyerAgent, body, key, "idemp-2", fx.stripe);
    assert.equal(first.order.id, second.order.id);

    await assert.rejects(
      () =>
        createOrder(
          fx.db,
          fx.buyerAgent,
          { ...body, quantity: 2 },
          key,
          "idemp-3",
          fx.stripe,
        ),
      (err: unknown) => err instanceof AppError && err.code === "idempotency_conflict",
    );
  });

  it("marks waiting orders stale when offer changes", async () => {
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "stale-1",
      fx.stripe,
    );

    updateCatalog(
      fx.db,
      fx.supplierAgent,
      {
        items: [
          {
            sku: "AVO-CASE-48",
            unit_price_minor: 5000,
            currency: "USD",
            advisory_quantity: 100,
            valid_from: fx.from,
            valid_until: fx.until,
            display_name: "Avocados A",
            display_description: "",
            active: true,
          },
        ],
      },
      "cat-1",
    );

    // supplier B is selected; change supplier B price via its agent
    const supplierBAgent = {
      ...fx.supplierAgent,
      organizationId: fx.supplierBId,
      auth0OrgId: "org_supplier_b",
      subject: "supplier-b-agent",
    };
    updateCatalog(
      fx.db,
      supplierBAgent,
      {
        items: [
          {
            sku: "AVO-CASE-48",
            unit_price_minor: 4100,
            currency: "USD",
            advisory_quantity: 100,
            valid_from: fx.from,
            valid_until: fx.until,
            display_name: "Avocados B",
            display_description: "",
            active: true,
          },
        ],
      },
      "cat-2",
    );

    await assert.rejects(
      () =>
        decideApproval(
          fx.db,
          fx.human,
          order.id,
          { decision: "approve" },
          "stale-2",
          fx.stripe,
        ),
      (err: unknown) => err instanceof AppError && err.code === "stale_order",
    );
  });

  it("superseding mandate stales awaiting approvals", async () => {
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "sup-1",
      fx.stripe,
    );

    createMandateVersion(
      fx.db,
      fx.human,
      {
        currency: "USD",
        autonomous_order_limit_minor: 5000,
        hard_exception_limit_minor: 50_000,
        budget_window_start: fx.from,
        budget_window_end: fx.until,
        budget_limit_minor: 100_000,
        allowed_supplier_org_ids: [fx.supplierAId, fx.supplierBId],
        allowed_categories: ["produce"],
        allowed_delivery_location_ids: ["kitchen-1"],
        valid_from: fx.from,
        valid_until: fx.until,
      },
      "sup-2",
    );

    const row = fx.db.prepare(`SELECT status FROM orders WHERE id = ?`).get(order.id) as {
      status: string;
    };
    assert.equal(row.status, "stale");
  });

  it("denies hard exceptions and never creates PaymentIntent", async () => {
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 20,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "deny-1",
      fx.stripe,
    );
    assert.equal(order.status, "denied");
    assert.equal(order.stripe_payment_intent_id, null);
    assert.equal(fx.stripe.intents.size, 0);
  });

  it("expires approvals and abandons failed payments", async () => {
    process.env.APPROVAL_TTL_SECONDS = "1";
    const { resetConfigCache } = await import("../src/lib/config");
    resetConfigCache();
    fx = setupFixture(`expire-${randomUUID()}`);

    // force expiry in the past
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "exp-1",
      fx.stripe,
    );
    fx.db
      .prepare(`UPDATE orders SET approval_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), order.id);

    const n = expireApprovals(fx.db, "exp-2");
    assert.equal(n, 1);

    // autonomous allow path then force failure abandonment
    createMandateVersion(
      fx.db,
      fx.human,
      {
        currency: "USD",
        autonomous_order_limit_minor: 50_000,
        hard_exception_limit_minor: 50_000,
        budget_window_start: fx.from,
        budget_window_end: fx.until,
        budget_limit_minor: 100_000,
        allowed_supplier_org_ids: [fx.supplierAId, fx.supplierBId],
        allowed_categories: ["produce"],
        allowed_delivery_location_ids: ["kitchen-1"],
        valid_from: fx.from,
        valid_until: fx.until,
      },
      "exp-3",
    );

    const created = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 1,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "fail-1",
      fx.stripe,
    );
    fx.db
      .prepare(`UPDATE orders SET status = 'payment_failed' WHERE id = ?`)
      .run(created.order.id);

    const abandoned = await abandonFailedPayment(
      fx.db,
      fx.human,
      created.order.id,
      "fail-2",
      fx.stripe,
    );
    assert.equal(abandoned.status, "cancelled");
  });

  it("handles out-of-order webhooks without regressing paid", async () => {
    createMandateVersion(
      fx.db,
      fx.human,
      {
        currency: "USD",
        autonomous_order_limit_minor: 50_000,
        hard_exception_limit_minor: 50_000,
        budget_window_start: fx.from,
        budget_window_end: fx.until,
        budget_limit_minor: 100_000,
        allowed_supplier_org_ids: [fx.supplierAId, fx.supplierBId],
        allowed_categories: ["produce"],
        allowed_delivery_location_ids: ["kitchen-1"],
        valid_from: fx.from,
        valid_until: fx.until,
      },
      "ooo-mandate",
    );

    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 1,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "ooo-1",
      fx.stripe,
    );
    assert.equal(order.status, "payment_pending");
    const pi = order.stripe_payment_intent_id!;

    handleStripeWebhook(
      fx.db,
      {
        id: "evt_ooo_ok",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: pi,
            amount: order.total_minor,
            currency: "usd",
            metadata: { order_id: order.id },
          },
        },
      },
      "ooo-2",
    );
    handleStripeWebhook(
      fx.db,
      {
        id: "evt_ooo_fail",
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: pi,
            amount: order.total_minor,
            currency: "usd",
            metadata: { order_id: order.id },
          },
        },
      },
      "ooo-3",
    );

    const row = fx.db.prepare(`SELECT status FROM orders WHERE id = ?`).get(order.id) as {
      status: string;
    };
    assert.equal(row.status, "paid");
  });

  it("rejects requester self-approval", async () => {
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "self-1",
      fx.stripe,
    );

    const selfApprover = {
      ...fx.human,
      subject: fx.buyerAgent.subject,
    };
    await assert.rejects(
      () =>
        decideApproval(
          fx.db,
          selfApprover,
          order.id,
          { decision: "approve" },
          "self-2",
          fx.stripe,
        ),
      (err: unknown) => err instanceof AppError && err.status === 403,
    );
  });
});
