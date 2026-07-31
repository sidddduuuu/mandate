import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { closeDb } from "../src/db";
import { updateCatalog } from "../src/catalog/catalog";
import { createMandateVersion } from "../src/procurement/mandates";
import {
  committedSpendMinor,
  createOrder,
  decideApproval,
  getOrderForActor,
  handleStripeWebhook,
  abandonFailedPayment,
  expireApprovals,
  serializeOrder,
} from "../src/procurement/orders";
import { setupFixture, type DemoFixture } from "./helpers";
import { AppError } from "../src/lib/http";
import { createStripeAdapter } from "../src/payments/stripe";
import { resetConfigCache } from "../src/lib/config";

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
    assert.equal(
      Date.parse(order.approval_expires_at!) - Date.parse(order.created_at),
      15 * 60_000,
    );
    assert.deepEqual(
      fx.db
        .prepare(
          `SELECT buyer_org_id, currency, budget_window_start, budget_window_end,
                  amount_minor, status
           FROM budget_reservations WHERE order_id = ?`,
        )
        .get(order.id),
      {
        buyer_org_id: fx.buyerOrgId,
        currency: "USD",
        budget_window_start: fx.from,
        budget_window_end: fx.until,
        amount_minor: 7800,
        status: "held",
      },
    );
    assert.throws(
      () =>
        fx.db
          .prepare(`UPDATE orders SET total_minor = total_minor + 1 WHERE id = ?`)
          .run(order.id),
      /order snapshots are immutable/,
    );
  });

  it("keeps approval and denial paths independent of Stripe configuration", async () => {
    process.env.STRIPE_SECRET_KEY = "";
    resetConfigCache();
    const stripe = createStripeAdapter();

    const approval = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "no-stripe-approval",
      stripe,
    );
    assert.equal(approval.order.status, "awaiting_approval");

    const denial = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 20,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "no-stripe-denial",
      stripe,
    );
    assert.equal(denial.order.status, "denied");
    assert.equal(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM budget_reservations WHERE order_id = ?`)
          .get(denial.order.id) as { n: number }
      ).n,
      0,
    );
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

  it("serializes concurrent idempotent requests into one order and reservation", async () => {
    const key = randomUUID();
    const body = {
      product_key: "avocado",
      unit: "case",
      quantity: 2,
      delivery_location_id: "kitchen-1",
    };
    const [first, second] = await Promise.all([
      createOrder(fx.db, fx.buyerAgent, body, key, "race-1", fx.stripe),
      createOrder(fx.db, fx.buyerAgent, body, key, "race-2", fx.stripe),
    ]);
    assert.equal(first.order.id, second.order.id);
    assert.equal(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?`)
          .get(key) as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM budget_reservations WHERE order_id = ?`)
          .get(first.order.id) as { n: number }
      ).n,
      1,
    );
  });

  it("rolls back order and audits when reservation persistence fails", async () => {
    fx.db.exec(
      `CREATE TRIGGER reject_budget_reservation
       BEFORE INSERT ON budget_reservations
       BEGIN
         SELECT RAISE(ABORT, 'injected reservation failure');
       END`,
    );
    const key = randomUUID();
    await assert.rejects(
      () =>
        createOrder(
          fx.db,
          fx.buyerAgent,
          {
            product_key: "avocado",
            unit: "case",
            quantity: 2,
            delivery_location_id: "kitchen-1",
          },
          key,
          "atomic-1",
          fx.stripe,
        ),
      /injected reservation failure/,
    );
    assert.equal(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?`)
          .get(key) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE request_id = 'atomic-1'`)
          .get() as { n: number }
      ).n,
      0,
    );
  });

  it("shares budget identity across mandate versions and isolates other windows", async () => {
    await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 1,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "budget-1",
      fx.stripe,
    );
    createMandateVersion(
      fx.db,
      fx.human,
      {
        currency: "USD",
        autonomous_order_limit_minor: 50_000,
        hard_exception_limit_minor: 50_000,
        budget_window_start: fx.from,
        budget_window_end: fx.until,
        budget_limit_minor: 5000,
        allowed_supplier_org_ids: [fx.supplierAId, fx.supplierBId],
        allowed_categories: ["produce"],
        allowed_delivery_location_ids: ["kitchen-1"],
        valid_from: fx.from,
        valid_until: fx.until,
      },
      "budget-2",
    );
    const second = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 1,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "budget-3",
      fx.stripe,
    );
    assert.equal(second.order.status, "awaiting_approval");
    assert.deepEqual(JSON.parse(second.order.policy_reasons_json), [
      "above_period_budget",
    ]);
    assert.equal(
      committedSpendMinor(
        fx.db,
        fx.buyerOrgId,
        "USD",
        new Date(Date.parse(fx.until) + 1000).toISOString(),
        new Date(Date.parse(fx.until) + 86_401_000).toISOString(),
      ),
      0,
    );
  });

  it("scopes reads and keeps the supplier projection fulfillment-only", async () => {
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
      "read-1",
      fx.stripe,
    );
    assert.equal(getOrderForActor(fx.db, fx.buyerAgent, order.id).id, order.id);
    assert.throws(
      () => getOrderForActor(fx.db, fx.supplierAgent, order.id),
      (error: unknown) => error instanceof AppError && error.code === "not_found",
    );
    const supplier = {
      ...fx.supplierAgent,
      organizationId: fx.supplierBId,
      auth0OrgId: "org_supplier_b",
    };
    const projection = serializeOrder(
      getOrderForActor(fx.db, supplier, order.id),
      "supplier",
    );
    assert.equal(projection.id, order.id);
    assert.equal("buyer_org_id" in projection, false);
    assert.equal("policy_decision" in projection, false);
    assert.equal("total_minor" in projection, false);
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
    fx = setupFixture(`expire-${randomUUID()}`);

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
    const n = expireApprovals(
      fx.db,
      "exp-2",
      new Date(Date.parse(order.created_at) + 16 * 60_000).toISOString(),
    );
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
