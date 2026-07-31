import Stripe from "stripe";
import { z } from "zod";

import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError } from "../http.ts";
import {
  releaseOfferReservation,
  settleOfferReservation,
} from "../procurement/reservations.ts";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const supportedEventType = z.enum([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);
const supportedAccountEventType = z.enum([
  "v2.core.account.created",
  "v2.core.account.updated",
  "v2.core.account.closed",
  "v2.core.account[configuration.recipient].updated",
  "v2.core.account[configuration.recipient].capability_status_updated",
  "v2.core.account[requirements].updated",
]);
const accountEventSchema = z.object({
  id: z.string().min(1).max(128),
  object: z.literal("v2.core.event"),
  type: supportedAccountEventType,
  created: z.string().datetime(),
  related_object: z.object({
    id: z.string().min(1).max(128),
    type: z.literal("v2.core.account"),
    url: z.string().min(1),
  }),
}).passthrough();
const paymentEventSchema = z.object({
  id: z.string().min(1).max(128),
  type: supportedEventType,
  data: z.object({
    object: z.object({
      id: z.string().min(1).max(128),
      object: z.literal("payment_intent"),
      amount: z.number().int().nonnegative(),
      currency: z.string().length(3),
      livemode: z.boolean(),
      latest_charge: z.union([
        z.string().min(1).max(128),
        z.object({ id: z.string().min(1).max(128) }).passthrough(),
      ]).nullable().optional(),
      metadata: z.record(z.string(), z.string()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export type PaymentEvent = Readonly<{
  id: string;
  type: z.output<typeof supportedEventType>;
  paymentIntentId: string;
  orderId: string | null;
  walletTopUpId?: string | null;
  chargeId?: string | null;
  amountMinor: number;
  currency: string;
  livemode: boolean;
}>;

export type StripeReconciliation = Readonly<{
  outcome: "processed" | "ignored" | "duplicate";
  orderId: string | null;
  orderStatus: string | null;
}>;

export type VerifiedStripeEvent = Stripe.Event | Stripe.V2.Core.EventNotification;

export type SupplierAccountEvent = Readonly<{
  id: string;
  type: z.output<typeof supportedAccountEventType>;
  created: string;
  accountId: string;
}>;

function stripeConfiguration(): Readonly<{
  apiKey: string;
  webhookSecret: string;
}> {
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!apiKey || !webhookSecret) {
    throw new ApiError(
      503,
      "STRIPE_UNAVAILABLE",
      "Stripe webhook handling is unavailable",
    );
  }
  return Object.freeze({ apiKey, webhookSecret });
}

async function rawBody(
  request: Request,
  maxBytes = MAX_WEBHOOK_BYTES,
): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Webhook body is too large",
    );
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Webhook body is too large",
    );
  }
  return body;
}

export async function verifyStripeWebhook(
  request: Request,
): Promise<VerifiedStripeEvent> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    throw new ApiError(
      400,
      "INVALID_STRIPE_SIGNATURE",
      "Stripe signature is invalid",
    );
  }
  const body = await rawBody(request);
  const { apiKey, webhookSecret } = stripeConfiguration();
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    const object = z.object({ object: z.string() }).passthrough().parse(parsed);
    const stripe = new Stripe(apiKey);
    return object.object === "event"
      ? await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
      : await stripe.parseEventNotificationAsync(body, signature, webhookSecret);
  } catch {
    throw new ApiError(
      400,
      "INVALID_STRIPE_SIGNATURE",
      "Stripe signature is invalid",
    );
  }
}

export function paymentEvent(event: VerifiedStripeEvent): PaymentEvent | null {
  if (event.object !== "event") return null;
  if (!supportedEventType.safeParse(event.type).success) return null;
  const result = paymentEventSchema.safeParse(event);
  if (!result.success) {
    throw new ApiError(
      400,
      "INVALID_STRIPE_EVENT",
      "Stripe event is invalid",
    );
  }
  const object = result.data.data.object;
  return Object.freeze({
    id: result.data.id,
    type: result.data.type,
    paymentIntentId: object.id,
    orderId: object.metadata.order_id || null,
    walletTopUpId: object.metadata.wallet_topup_id || null,
    chargeId: typeof object.latest_charge === "string"
      ? object.latest_charge
      : object.latest_charge?.id ?? null,
    amountMinor: object.amount,
    currency: object.currency.toUpperCase(),
    livemode: object.livemode,
  });
}

export function supplierAccountEvent(
  event: VerifiedStripeEvent,
): SupplierAccountEvent | null {
  if (event.object === "event") return null;
  if (!supportedAccountEventType.safeParse(event.type).success) return null;
  const parsed = accountEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_STRIPE_EVENT", "Stripe event is invalid");
  }
  return Object.freeze({
    id: parsed.data.id,
    type: parsed.data.type,
    created: parsed.data.created,
    accountId: parsed.data.related_object.id,
  });
}

async function audit(
  database: Database,
  event: PaymentEvent,
  organizationId: string | null,
  aggregateId: string,
  eventType: string,
  requestId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string,
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (
      aggregate_type, aggregate_id, organization_id, event_type, actor_type,
      actor_subject, request_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?)
  `,
    organizationId ? "order" : "payment_intent",
    aggregateId,
    organizationId,
    eventType,
    event.id,
    requestId,
    JSON.stringify(payload),
    createdAt,
  );
}

async function recordEvent(
  database: Database,
  event: PaymentEvent,
  receivedAt: string,
): Promise<boolean> {
  const inserted = await database.get(`
    INSERT INTO stripe_events (
      event_id, type, object_id, received_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
    RETURNING event_id
  `, event.id, event.type, event.paymentIntentId, receivedAt);
  return Boolean(inserted);
}

async function markProcessed(
  database: Database,
  eventId: string,
  processedAt: string,
): Promise<void> {
  await database.run(
    "UPDATE stripe_events SET processed_at = ? WHERE event_id = ?",
    processedAt,
    eventId,
  );
}

function nextStatus(
  type: PaymentEvent["type"],
  status: string,
): string | null {
  if (type === "payment_intent.succeeded") {
    if (status === "paid") return status;
    if (["payment_pending", "payment_failed", "cancelled"].includes(status)) {
      return "paid";
    }
    return null;
  }
  if (type === "payment_intent.payment_failed") {
    if (status === "payment_failed") return status;
    return status === "payment_pending" ? "payment_failed" : null;
  }
  if (status === "cancelled") return status;
  return ["payment_pending", "payment_failed"].includes(status)
    ? "cancelled"
    : null;
}

async function ignored(
  database: Database,
  event: PaymentEvent,
  requestId: string,
  receivedAt: string,
  reason: string,
  order: Record<string, unknown> | undefined,
): Promise<StripeReconciliation> {
  await markProcessed(database, event.id, receivedAt);
  await audit(
    database,
    event,
    typeof order?.buyer_organization_id === "string"
      ? order.buyer_organization_id
      : null,
    typeof order?.id === "string" ? order.id : event.paymentIntentId,
    "stripe.webhook_ignored",
    requestId,
    {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId: event.paymentIntentId,
      reason,
    },
    receivedAt,
  );
  return Object.freeze({
    outcome: "ignored",
    orderId: typeof order?.id === "string" ? order.id : null,
    orderStatus: typeof order?.status === "string" ? order.status : null,
  });
}

async function reconcileWalletTopUp(
  database: Database,
  event: PaymentEvent,
  requestId: string,
  receivedAt: string,
): Promise<StripeReconciliation | null> {
  if (!event.walletTopUpId) return null;
  const topup = await database.get(`
    SELECT id, organization_id, amount, currency, status,
      stripe_payment_intent_id
    FROM wallet_topups WHERE id = ? FOR UPDATE
  `, event.walletTopUpId);
  if (
    !topup
    || event.livemode
    || (event.type === "payment_intent.succeeded" && !event.chargeId)
    || (
      topup.stripe_payment_intent_id
      && topup.stripe_payment_intent_id !== event.paymentIntentId
    )
    || Number(topup.amount) !== event.amountMinor
    || topup.currency !== event.currency
  ) {
    await markProcessed(database, event.id, receivedAt);
    await audit(
      database,
      event,
      null,
      event.paymentIntentId,
      "stripe.webhook_ignored",
      requestId,
      { reason: "WALLET_TOPUP_MISMATCH", eventType: event.type },
      receivedAt,
    );
    return Object.freeze({
      outcome: "ignored",
      orderId: null,
      orderStatus: null,
    });
  }
  if (!topup.stripe_payment_intent_id) {
    const bound = await database.run(`
      UPDATE wallet_topups SET stripe_payment_intent_id = ?, updated_at = ?
      WHERE id = ? AND stripe_payment_intent_id IS NULL AND status = 'pending'
    `, event.paymentIntentId, receivedAt, topup.id);
    if (bound.changes !== 1) {
      throw new Error("Wallet top-up binding lost its compare-and-set");
    }
  }

  const succeeded = event.type === "payment_intent.succeeded";
  const status = succeeded ? "paid" : topup.status === "paid" ? "paid" : "failed";
  if (!succeeded && topup.status === "pending") {
    await database.run(
      "UPDATE wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'",
      receivedAt,
      topup.id,
    );
  }
  if (succeeded) {
    await database.run(
      "UPDATE wallet_topups SET status = 'paid', updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')",
      receivedAt,
      topup.id,
    );
    await database.run(`
      INSERT INTO wallet_funding_lots (
        id, wallet_topup_id, organization_id, stripe_payment_intent_id,
        stripe_charge_id, original_amount, available_amount, currency,
        status, funded_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
      ON CONFLICT DO NOTHING
    `,
      topup.id,
      topup.id,
      topup.organization_id,
      event.paymentIntentId,
      event.chargeId,
      topup.amount,
      topup.amount,
      topup.currency,
      receivedAt,
      receivedAt,
    );
    const lot = await database.get(`
      SELECT organization_id, stripe_payment_intent_id, stripe_charge_id,
        original_amount, currency
      FROM wallet_funding_lots WHERE wallet_topup_id = ?
    `, topup.id);
    if (
      !lot
      || lot.organization_id !== topup.organization_id
      || lot.stripe_payment_intent_id !== event.paymentIntentId
      || lot.stripe_charge_id !== event.chargeId
      || Number(lot.original_amount) !== Number(topup.amount)
      || lot.currency !== topup.currency
    ) throw new Error("Wallet funding lot does not match its Stripe charge");
    const funding = await database.get(`
      INSERT INTO wallet_transactions (
        organization_id, kind, amount, stripe_payment_intent_id, created_at
      ) VALUES (?, 'funding', ?, ?, ?)
      ON CONFLICT(stripe_payment_intent_id) DO NOTHING
      RETURNING id
    `, topup.organization_id, topup.amount, event.paymentIntentId, receivedAt);
    if (funding) await database.run(`
      INSERT INTO wallet_accounts (
        organization_id, currency, balance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET
        balance = wallet_accounts.balance + excluded.balance,
        updated_at = excluded.updated_at
    `, topup.organization_id, topup.currency, topup.amount, receivedAt, receivedAt);
  }
  await markProcessed(database, event.id, receivedAt);
  await database.run(`
    INSERT INTO audit_events (
      aggregate_type, aggregate_id, organization_id, event_type, actor_type,
      actor_subject, request_id, payload_json, created_at
    ) VALUES ('wallet_topup', ?, ?, 'wallet.topup_reconciled', 'stripe', ?, ?, ?, ?)
  `, topup.id, topup.organization_id, event.id, requestId, JSON.stringify({
    amountMinor: event.amountMinor,
    currency: event.currency,
    paymentIntentId: event.paymentIntentId,
    status,
  }), receivedAt);
  return Object.freeze({
    outcome: "processed",
    orderId: null,
    orderStatus: status,
  });
}

export async function reconcileStripeEvent(
  database: Database,
  event: PaymentEvent,
  requestId: string,
  now = new Date(),
): Promise<StripeReconciliation> {
  const receivedAt = now.toISOString();
  return withImmediateTransaction(database, async (tx) => {
    if (!await recordEvent(tx, event, receivedAt)) {
      return Object.freeze({
        outcome: "duplicate",
        orderId: event.orderId,
        orderStatus: null,
      });
    }
    const wallet = await reconcileWalletTopUp(
      tx,
      event,
      requestId,
      receivedAt,
    );
    if (wallet) return wallet;
    const order = event.orderId
      ? await tx.get(`
          SELECT id, buyer_organization_id, status, total, currency,
            stripe_payment_intent_id
          FROM orders WHERE id = ?
          FOR UPDATE
        `, event.orderId)
      : undefined;
    if (!order) {
      return await ignored(
        tx,
        event,
        requestId,
        receivedAt,
        "ORDER_NOT_FOUND",
        undefined,
      );
    }
    if (
      event.livemode
      || order.stripe_payment_intent_id !== event.paymentIntentId
      || Number(order.total) !== event.amountMinor
      || order.currency !== event.currency
    ) {
      return await ignored(
        tx,
        event,
        requestId,
        receivedAt,
        "PAYMENT_MISMATCH",
        order,
      );
    }
    const previousStatus = String(order.status);
    const status = nextStatus(event.type, previousStatus);
    if (!status) {
      return await ignored(
        tx,
        event,
        requestId,
        receivedAt,
        "ORDER_STATE_MISMATCH",
        order,
      );
    }
    if (status !== previousStatus) {
      const updated = await tx.run(`
        UPDATE orders SET status = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, status, receivedAt, order.id, previousStatus);
      if (updated.changes !== 1) {
        throw new Error("Payment reconciliation lost its compare-and-set");
      }
    }
    if (status === "paid") {
      await settleOfferReservation(tx, String(order.id), receivedAt);
    } else if (status === "cancelled") {
      await releaseOfferReservation(tx, String(order.id), receivedAt);
    }
    await markProcessed(tx, event.id, receivedAt);
    await audit(
      tx,
      event,
      String(order.buyer_organization_id),
      String(order.id),
      "payment.reconciled",
      requestId,
      {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId: event.paymentIntentId,
        fromStatus: previousStatus,
        toStatus: status,
      },
      receivedAt,
    );
    return Object.freeze({
      outcome: "processed",
      orderId: String(order.id),
      orderStatus: status,
    });
  });
}
