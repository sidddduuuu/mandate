import Stripe from "stripe";

import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError } from "../http.ts";

const SAFE_CREATE_RETRY_MS = 23 * 60 * 60 * 1_000;

type PaymentIntent = Readonly<{
  id: string;
  amount: number;
  currency: string;
  livemode: boolean;
  metadata: Readonly<Record<string, string>>;
  status: string;
  lastResponse?: Readonly<{ requestId?: string }>;
}>;

export type PaymentIntentsClient = Readonly<{
  create(
    params: Stripe.PaymentIntentCreateParams,
    options: Stripe.RequestOptions,
  ): Promise<PaymentIntent>;
  confirm(
    id: string,
    params: Stripe.PaymentIntentConfirmParams,
    options: Stripe.RequestOptions,
  ): Promise<PaymentIntent>;
}>;

export type CheckoutSessionsClient = Readonly<{
  create(
    params: Stripe.Checkout.SessionCreateParams,
    options: Stripe.RequestOptions,
  ): Promise<Readonly<{
    id: string;
    url: string | null;
    livemode: boolean;
    amount_total: number | null;
    currency: string | null;
    metadata: Readonly<Record<string, string>> | null;
    lastResponse?: Readonly<{ requestId?: string }>;
  }>>;
}>;

type PaymentOrder = Readonly<{
  id: string;
  buyerOrganizationId: string;
  totalMinor: number;
  currency: string;
  status: string;
  customerId: string | null;
  createStartedAt: string | null;
  paymentIntentId: string | null;
}>;

function unavailable(): ApiError {
  return new ApiError(503, "PAYMENTS_UNAVAILABLE", "Payments are unavailable");
}

function paymentMethodId(): string {
  const value = process.env.STRIPE_PAYMENT_METHOD_ID?.trim();
  if (!value || value.length > 128) throw unavailable();
  return value;
}

function stripeClient(): Stripe {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret?.startsWith("sk_test_")) throw unavailable();
  return new Stripe(secret);
}

function paymentIntents(): PaymentIntentsClient {
  return stripeClient().paymentIntents;
}

function checkoutSessions(): CheckoutSessionsClient {
  return stripeClient().checkout.sessions;
}

async function loadOrder(
  database: Database,
  orderId: string,
  lock = false,
): Promise<PaymentOrder> {
  const row = await database.get(`
    SELECT o.id, o.buyer_organization_id, o.total, o.currency, o.status,
      o.stripe_create_started_at, o.stripe_payment_intent_id,
      b.stripe_customer_id
    FROM orders o
    JOIN organizations b ON b.id = o.buyer_organization_id
    WHERE o.id = ?
    ${lock ? "FOR UPDATE" : ""}
  `, orderId);
  if (!row) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  return Object.freeze({
    id: String(row.id),
    buyerOrganizationId: String(row.buyer_organization_id),
    totalMinor: Number(row.total),
    currency: String(row.currency),
    status: String(row.status),
    customerId: typeof row.stripe_customer_id === "string"
      ? row.stripe_customer_id
      : process.env.STRIPE_CUSTOMER_ID?.trim() || null,
    createStartedAt: typeof row.stripe_create_started_at === "string"
      ? row.stripe_create_started_at
      : null,
    paymentIntentId: typeof row.stripe_payment_intent_id === "string"
      ? row.stripe_payment_intent_id
      : null,
  });
}

async function audit(
  database: Database,
  order: PaymentOrder,
  eventType: string,
  requestId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string,
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (
      aggregate_type, aggregate_id, organization_id, event_type, actor_type,
      actor_subject, request_id, payload_json, created_at
    ) VALUES ('order', ?, ?, ?, 'system', NULL, ?, ?, ?)
  `,
    order.id, order.buyerOrganizationId, eventType, requestId,
    JSON.stringify(payload), createdAt,
  );
}

async function markCreateStarted(
  database: Database,
  order: PaymentOrder,
  requestId: string,
  now: string,
): Promise<PaymentOrder> {
  if (order.createStartedAt || order.paymentIntentId) return order;
  return withImmediateTransaction(database, async (tx) => {
    const current = await loadOrder(tx, order.id, true);
    if (current.status !== "payment_pending") {
      throw new ApiError(
        409,
        "PAYMENT_NOT_READY",
        "Order is not ready for payment",
      );
    }
    if (current.createStartedAt || current.paymentIntentId) return current;
    const updated = await tx.run(`
      UPDATE orders SET stripe_create_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'payment_pending'
        AND stripe_create_started_at IS NULL
    `, now, now, order.id);
    if (Number(updated.changes) > 0)
      await audit(
        tx, current, "stripe.payment_intent_create_started", requestId,
        {}, now,
      );
    return loadOrder(tx, order.id);
  });
}

function assertSafeRetry(order: PaymentOrder, now: Date): void {
  if (
    !order.paymentIntentId
    && order.createStartedAt
    && now.getTime() - Date.parse(order.createStartedAt) >= SAFE_CREATE_RETRY_MS
  ) {
    throw new ApiError(
      409,
      "PAYMENT_RECONCILIATION_REQUIRED",
      "Payment requires manual reconciliation",
    );
  }
}

function assertIntent(intent: PaymentIntent, order: PaymentOrder): void {
  if (
    !intent.id
    || intent.id.length > 128
    || intent.livemode
    || intent.amount !== order.totalMinor
    || intent.currency.toUpperCase() !== order.currency
    || intent.metadata.order_id !== order.id
  ) throw new Error("Stripe returned an invalid PaymentIntent");
}

async function createIntent(
  client: PaymentIntentsClient,
  order: PaymentOrder,
): Promise<PaymentIntent> {
  const intent = await client.create(
    {
      amount: order.totalMinor,
      currency: order.currency.toLowerCase(),
      confirmation_method: "manual",
      payment_method: paymentMethodId(),
      metadata: { order_id: order.id },
      ...(order.customerId ? { customer: order.customerId } : {}),
    },
    { idempotencyKey: `order:${order.id}:create` },
  );
  assertIntent(intent, order);
  return intent;
}

async function persistIntent(
  database: Database,
  order: PaymentOrder,
  intent: PaymentIntent,
  requestId: string,
  now: string,
): Promise<void> {
  await withImmediateTransaction(database, async (tx) => {
    const current = await loadOrder(tx, order.id, true);
    if (current.paymentIntentId && current.paymentIntentId !== intent.id)
      throw new Error("Order is mapped to a different PaymentIntent");
    if (current.paymentIntentId) return;
    const updated = await tx.run(`
      UPDATE orders SET stripe_payment_intent_id = ?, updated_at = ?
      WHERE id = ? AND stripe_payment_intent_id IS NULL
    `, intent.id, now, order.id);
    if (updated.changes !== 1) {
      throw new Error("PaymentIntent persistence lost its compare-and-set");
    }
    await audit(
      tx, order, "stripe.payment_intent_created", requestId,
      {
        paymentIntentId: intent.id,
        stripeRequestId: intent.lastResponse?.requestId ?? null,
      },
      now,
    );
  });
}

async function confirmIntent(
  client: PaymentIntentsClient,
  database: Database,
  order: PaymentOrder,
  paymentIntentId: string,
  requestId: string,
  now: string,
): Promise<void> {
  const intent = await client.confirm(
    paymentIntentId,
    { error_on_requires_action: true, off_session: true },
    { idempotencyKey: `order:${order.id}:confirm` },
  );
  assertIntent(intent, order);
  await withImmediateTransaction(database, (tx) => audit(
    tx, order, "stripe.payment_intent_confirmed", requestId,
    {
      paymentIntentId: intent.id,
      stripeRequestId: intent.lastResponse?.requestId ?? null,
      stripeStatus: intent.status,
    },
    now,
  ));
}

export async function initiateOrderPayment(
  database: Database,
  orderId: string,
  requestId: string,
  client = paymentIntents(),
  now = new Date(),
): Promise<void> {
  let order = await loadOrder(database, orderId);
  if (order.status !== "payment_pending")
    throw new ApiError(409, "PAYMENT_NOT_READY", "Order is not ready for payment");
  order = await markCreateStarted(
    database,
    order,
    requestId,
    now.toISOString(),
  );
  assertSafeRetry(order, now);
  let paymentIntentId = order.paymentIntentId;
  if (!paymentIntentId) {
    const intent = await createIntent(client, order);
    await persistIntent(database, order, intent, requestId, now.toISOString());
    paymentIntentId = intent.id;
  }
  await confirmIntent(
    client, database, order, paymentIntentId, requestId, now.toISOString(),
  );
}

export async function createWalletCheckout(
  database: Database,
  topup: Readonly<{
    id: string;
    organizationId: string;
    amountMinor: number;
    currency: string;
  }>,
  requestId: string,
  origin: string,
  client = checkoutSessions(),
  now = new Date(),
): Promise<string> {
  const session = await client.create(
    {
      mode: "payment",
      success_url: `${origin}/dashboard/wallet?funding=success`,
      cancel_url: `${origin}/dashboard/wallet?funding=cancelled`,
      client_reference_id: topup.id,
      integration_identifier: "mandate_wallet_qjfxnsvu",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: topup.currency.toLowerCase(),
          unit_amount: topup.amountMinor,
          product_data: { name: "Mandate prepaid wallet funding" },
        },
      }],
      payment_intent_data: {
        metadata: { wallet_topup_id: topup.id },
      },
      metadata: { wallet_topup_id: topup.id },
    },
    { idempotencyKey: `wallet-topup:${topup.id}:checkout` },
  );
  if (
    !session.id
    || !session.url
    || session.livemode
    || session.amount_total !== topup.amountMinor
    || session.currency?.toUpperCase() !== topup.currency
    || session.metadata?.wallet_topup_id !== topup.id
  ) throw new Error("Stripe returned an invalid wallet Checkout Session");
  const createdAt = now.toISOString();
  await withImmediateTransaction(database, async (tx) => {
    await tx.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('wallet_topup', ?, ?, 'stripe.wallet_checkout_created', 'system',
        NULL, ?, ?, ?)
    `, topup.id, topup.organizationId, requestId, JSON.stringify({
      amountMinor: topup.amountMinor,
      currency: topup.currency,
      checkoutSessionId: session.id,
      stripeRequestId: session.lastResponse?.requestId ?? null,
    }), createdAt);
  });
  return session.url;
}
