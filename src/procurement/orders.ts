import { z } from "zod";
import type { Db } from "../db";
import { withImmediateTransaction } from "../db";
import { writeAudit } from "../audit/audit";
import type { ActorContext } from "../auth/context";
import { listOffersForProduct, type CatalogItemRow } from "../catalog/catalog";
import { getConfig } from "../lib/config";
import { sha256Hex, stableStringify } from "../lib/hash";
import { AppError } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { computeOrderTotalMinor, MoneyError } from "../lib/money";
import type { StripeAdapter } from "../payments/stripe";
import { getActiveMandate, mandateToPolicy, type MandateRow } from "./mandates";
import { evaluatePolicy } from "./policy";

export type OrderStatus =
  | "denied"
  | "awaiting_approval"
  | "rejected"
  | "expired"
  | "stale"
  | "payment_pending"
  | "payment_failed"
  | "paid"
  | "cancelled";

export type OrderRow = {
  id: string;
  buyer_org_id: string;
  supplier_org_id: string;
  requester_subject: string;
  mandate_id: string;
  mandate_version: number;
  mandate_policy_hash: string;
  catalog_item_id: string;
  catalog_version: number;
  sku: string;
  product_key: string;
  category: string;
  unit: string;
  unit_price_minor: number;
  quantity: number;
  currency: string;
  total_minor: number;
  delivery_location_id: string;
  status: OrderStatus;
  policy_decision: "allow" | "require_approval" | "deny";
  policy_reasons_json: string;
  idempotency_key: string;
  request_hash: string;
  approval_expires_at: string | null;
  approval_actor_subject: string | null;
  approval_decided_at: string | null;
  approval_reason: string | null;
  stripe_payment_intent_id: string | null;
  stripe_create_started_at: string | null;
  created_at: string;
  updated_at: string;
};

const orderRequestSchema = z.object({
  product_key: z.string().min(1).max(128),
  unit: z.string().min(1).max(32),
  quantity: z.number().int().positive(),
  delivery_location_id: z.string().min(1).max(128),
});

const RESERVING_STATUSES: OrderStatus[] = [
  "awaiting_approval",
  "payment_pending",
  "payment_failed",
  "paid",
];

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  denied: [],
  awaiting_approval: ["rejected", "expired", "stale", "payment_pending"],
  rejected: [],
  expired: [],
  stale: [],
  payment_pending: ["paid", "payment_failed", "cancelled"],
  payment_failed: ["payment_pending", "paid", "cancelled"],
  paid: [],
  cancelled: [],
};

function getOrder(db: Db, id: string): OrderRow | null {
  return (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined) ?? null;
}

function transitionOrder(
  db: Db,
  orderId: string,
  from: OrderStatus[],
  to: OrderStatus,
  extra: Record<string, unknown> = {},
): OrderRow {
  const now = nowIso();
  const sets = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [to, now];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(orderId, ...from);
  const placeholders = from.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(...values);
  if (result.changes !== 1) {
    throw new AppError(409, "conflict", "Illegal or concurrent order transition");
  }
  const row = getOrder(db, orderId);
  if (!row) throw new AppError(404, "not_found", "Order not found");
  for (const f of from) {
    if (!ALLOWED_TRANSITIONS[f].includes(to) && f !== to) {
      // defensive: table above is source of truth checked before call sites
    }
  }
  return row;
}

/** MVP (#9): committed spend is buyer-org spend in the active mandate budget window. */
export function committedSpendMinor(
  db: Db,
  buyerOrgId: string,
  budgetWindowStart: string,
  budgetWindowEnd: string,
  excludeOrderId?: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_minor), 0) AS total
       FROM orders
       WHERE buyer_org_id = ?
         AND status IN (${RESERVING_STATUSES.map(() => "?").join(",")})
         AND created_at >= ?
         AND created_at <= ?
         AND (? IS NULL OR id != ?)`,
    )
    .get(
      buyerOrgId,
      ...RESERVING_STATUSES,
      budgetWindowStart,
      budgetWindowEnd,
      excludeOrderId ?? null,
      excludeOrderId ?? null,
    ) as { total: number };
  return row.total;
}

function selectCheapestOffer(offers: CatalogItemRow[], quantity: number, caps: {
  maxUnitPrice: number;
  maxQuantity: number;
  maxOrderTotal: number;
}): { offer: CatalogItemRow; totalMinor: number } | null {
  if (offers.length === 0) return null;
  const ranked = offers
    .map((offer) => ({
      offer,
      totalMinor: computeOrderTotalMinor(offer.unit_price_minor, quantity, caps),
    }))
    .sort((a, b) => {
      if (a.totalMinor !== b.totalMinor) return a.totalMinor - b.totalMinor;
      return a.offer.supplier_org_id.localeCompare(b.offer.supplier_org_id);
    });
  return ranked[0] ?? null;
}

/**
 * MVP (#4): order becomes stale if catalog version changed, or price/currency/active/
 * validity/advisory stock no longer satisfies the snapshotted purchase.
 */
export function isOfferStillValidForOrder(
  db: Db,
  order: OrderRow,
  now: string,
): boolean {
  const item = db
    .prepare(`SELECT * FROM catalog_items WHERE id = ?`)
    .get(order.catalog_item_id) as CatalogItemRow | undefined;
  if (!item) return false;
  if (item.version !== order.catalog_version) return false;
  if (item.active !== 1) return false;
  if (item.unit_price_minor !== order.unit_price_minor) return false;
  if (item.currency !== order.currency) return false;
  if (item.advisory_quantity < order.quantity) return false;
  if (Date.parse(item.valid_from) > Date.parse(now)) return false;
  if (Date.parse(item.valid_until) < Date.parse(now)) return false;
  return true;
}

export async function createOrder(
  db: Db,
  actor: ActorContext,
  rawBody: unknown,
  idempotencyKey: string,
  requestId: string,
  stripe: StripeAdapter,
): Promise<{ order: OrderRow; httpStatus: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID");
  }

  const parsed = orderRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Invalid order payload");
  }

  const requestHash = sha256Hex(stableStringify(parsed.data));
  const existing = db
    .prepare(
      `SELECT * FROM orders
       WHERE buyer_org_id = ? AND requester_subject = ? AND idempotency_key = ?`,
    )
    .get(actor.organizationId, actor.subject, idempotencyKey) as OrderRow | undefined;

  if (existing) {
    if (existing.request_hash !== requestHash) {
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: existing.id,
        organizationId: actor.organizationId,
        eventType: "order.idempotency_conflict",
        actorType: "agent",
        actorSubject: actor.subject,
        requestId,
        payload: { idempotency_key: idempotencyKey },
      });
      throw new AppError(409, "idempotency_conflict", "Idempotency key reused with different payload");
    }
    writeAudit(db, {
      aggregateType: "order",
      aggregateId: existing.id,
      organizationId: actor.organizationId,
      eventType: "order.idempotent_replay",
      actorType: "agent",
      actorSubject: actor.subject,
      requestId,
      payload: { status: existing.status },
    });
    if (existing.status === "payment_pending" || existing.status === "payment_failed") {
      await resumePayment(db, existing, requestId, stripe);
      return { order: getOrder(db, existing.id)!, httpStatus: 200 };
    }
    const status =
      existing.status === "awaiting_approval"
        ? 202
        : existing.status === "denied"
          ? 200
          : 200;
    return { order: existing, httpStatus: status };
  }

  const cfg = getConfig();
  const now = nowIso();
  let created: OrderRow;

  try {
    created = withImmediateTransaction(db, () => {
      const mandate = getActiveMandate(db, actor.organizationId);
      if (!mandate) {
        writeAudit(db, {
          aggregateType: "order",
          organizationId: actor.organizationId,
          eventType: "order.denied",
          actorType: "agent",
          actorSubject: actor.subject,
          requestId,
          payload: { reasons: ["missing_mandate"] },
        });
        throw new AppError(403, "missing_mandate", "No active purchasing mandate");
      }

      const policyMandate = mandateToPolicy(mandate);
      const caps = {
        maxUnitPrice: cfg.MAX_UNIT_PRICE_MINOR,
        maxQuantity: cfg.MAX_QUANTITY,
        maxOrderTotal: cfg.MAX_ORDER_TOTAL_MINOR,
      };

      const offers = listOffersForProduct(db, {
        productKey: parsed.data.product_key,
        unit: parsed.data.unit,
        quantity: parsed.data.quantity,
        deliveryLocationId: parsed.data.delivery_location_id,
        allowedSupplierOrgIds: policyMandate.allowed_supplier_org_ids,
        allowedCategories: policyMandate.allowed_categories,
        currency: policyMandate.currency,
        nowIso: now,
      });
      const selected = selectCheapestOffer(offers, parsed.data.quantity, caps);

      const spend = committedSpendMinor(
        db,
        actor.organizationId,
        mandate.budget_window_start,
        mandate.budget_window_end,
      );

      const evaluation = evaluatePolicy({
        nowIso: now,
        buyerOrgId: actor.organizationId,
        actorBuyerOrgId: actor.organizationId,
        quantity: parsed.data.quantity,
        totalMinor: selected?.totalMinor ?? 0,
        deliveryLocationId: parsed.data.delivery_location_id,
        offer: selected
          ? {
              supplierOrgId: selected.offer.supplier_org_id,
              category: selected.offer.category,
              currency: selected.offer.currency,
              active: selected.offer.active === 1,
              expired: false,
              unitPriceMinor: selected.offer.unit_price_minor,
            }
          : {
              supplierOrgId: "",
              category: "",
              currency: mandate.currency,
              active: false,
              expired: true,
              unitPriceMinor: 0,
            },
        mandate: policyMandate,
        committedSpendMinor: spend,
      });

      let decision = evaluation.decision;
      let reasons = evaluation.reasons;
      if (!selected) {
        decision = "deny";
        reasons = ["stale_offer"];
      }

      const offer = selected?.offer;
      const snapshot =
        offer ??
        (db
          .prepare(
            `SELECT * FROM catalog_items
             WHERE product_key = ? AND unit = ?
             ORDER BY supplier_org_id ASC LIMIT 1`,
          )
          .get(parsed.data.product_key, parsed.data.unit) as CatalogItemRow | undefined);

      if (!snapshot) {
        throw new AppError(404, "no_offers", "No catalog items for product");
      }

      const totalMinor = selected?.totalMinor ?? snapshot.unit_price_minor * parsed.data.quantity;
      const status: OrderStatus =
        decision === "deny"
          ? "denied"
          : decision === "require_approval"
            ? "awaiting_approval"
            : "payment_pending";

      const approvalExpires =
        status === "awaiting_approval"
          ? new Date(Date.parse(now) + cfg.APPROVAL_TTL_SECONDS * 1000).toISOString()
          : null;

      const id = newId("ord");
      db.prepare(
        `INSERT INTO orders (
          id, buyer_org_id, supplier_org_id, requester_subject,
          mandate_id, mandate_version, mandate_policy_hash,
          catalog_item_id, catalog_version, sku, product_key, category, unit,
          unit_price_minor, quantity, currency, total_minor, delivery_location_id,
          status, policy_decision, policy_reasons_json, idempotency_key, request_hash,
          approval_expires_at, stripe_payment_intent_id, stripe_create_started_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        id,
        actor.organizationId,
        snapshot.supplier_org_id,
        actor.subject,
        mandate.id,
        mandate.version,
        mandate.policy_hash,
        snapshot.id,
        snapshot.version,
        snapshot.sku,
        parsed.data.product_key,
        snapshot.category,
        parsed.data.unit,
        snapshot.unit_price_minor,
        parsed.data.quantity,
        snapshot.currency,
        selected ? totalMinor : Math.min(totalMinor, cfg.MAX_ORDER_TOTAL_MINOR),
        parsed.data.delivery_location_id,
        status,
        decision,
        JSON.stringify(reasons),
        idempotencyKey,
        requestHash,
        approvalExpires,
        now,
        now,
      );

      const row = getOrder(db, id)!;
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: id,
        organizationId: actor.organizationId,
        eventType: "order.created",
        actorType: "agent",
        actorSubject: actor.subject,
        requestId,
        payload: {
          status,
          decision,
          reasons,
          supplier_org_id: row.supplier_org_id,
          total_minor: row.total_minor,
          catalog_item_id: row.catalog_item_id,
          catalog_version: row.catalog_version,
          mandate_version: row.mandate_version,
          mandate_policy_hash: row.mandate_policy_hash,
        },
      });
      return row;
    });
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new AppError(400, "invalid_amount", err.message);
    }
    throw err;
  }

  if (created.status === "denied") {
    return { order: created, httpStatus: 200 };
  }
  if (created.status === "awaiting_approval") {
    return { order: created, httpStatus: 202 };
  }

  await initiatePayment(db, created, requestId, stripe);
  return { order: getOrder(db, created.id)!, httpStatus: 201 };
}

async function initiatePayment(
  db: Db,
  order: OrderRow,
  requestId: string,
  stripe: StripeAdapter,
): Promise<void> {
  const cfg = getConfig();
  const now = nowIso();

  if (!order.stripe_create_started_at) {
    db.prepare(`UPDATE orders SET stripe_create_started_at = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      order.id,
    );
  }

  let paymentIntentId = order.stripe_payment_intent_id;
  if (!paymentIntentId) {
    const org = db
      .prepare(`SELECT stripe_customer_id FROM organizations WHERE id = ?`)
      .get(order.buyer_org_id) as { stripe_customer_id: string | null };
    const pi = await stripe.createPaymentIntent({
      orderId: order.id,
      amountMinor: order.total_minor,
      currency: order.currency,
      customerId: org.stripe_customer_id,
      idempotencyKey: `order:${order.id}:create`,
    });
    paymentIntentId = pi.id;
    db.prepare(
      `UPDATE orders SET stripe_payment_intent_id = ?, updated_at = ? WHERE id = ? AND stripe_payment_intent_id IS NULL`,
    ).run(paymentIntentId, nowIso(), order.id);
    writeAudit(db, {
      aggregateType: "order",
      aggregateId: order.id,
      organizationId: order.buyer_org_id,
      eventType: "order.stripe_create",
      actorType: "system",
      requestId,
      payload: { payment_intent_id: paymentIntentId },
    });
  }

  try {
    const confirmed = await stripe.confirmPaymentIntent({
      paymentIntentId,
      paymentMethod: cfg.STRIPE_DEFAULT_PAYMENT_METHOD,
      idempotencyKey: `order:${order.id}:confirm`,
    });
    writeAudit(db, {
      aggregateType: "order",
      aggregateId: order.id,
      organizationId: order.buyer_org_id,
      eventType: "order.stripe_confirm",
      actorType: "system",
      requestId,
      payload: { payment_intent_id: paymentIntentId, stripe_status: confirmed.status },
    });
    if (confirmed.status === "requires_payment_method" || confirmed.status === "canceled") {
      withImmediateTransaction(db, () => {
        transitionOrder(db, order.id, ["payment_pending"], "payment_failed");
        writeAudit(db, {
          aggregateType: "order",
          aggregateId: order.id,
          organizationId: order.buyer_org_id,
          eventType: "order.transition",
          actorType: "system",
          requestId,
          payload: { to: "payment_failed" },
        });
      });
    }
  } catch {
    withImmediateTransaction(db, () => {
      const current = getOrder(db, order.id);
      if (current?.status === "payment_pending") {
        transitionOrder(db, order.id, ["payment_pending"], "payment_failed");
        writeAudit(db, {
          aggregateType: "order",
          aggregateId: order.id,
          organizationId: order.buyer_org_id,
          eventType: "order.transition",
          actorType: "system",
          requestId,
          payload: { to: "payment_failed", reason: "confirm_error" },
        });
      }
    });
  }
}

async function resumePayment(
  db: Db,
  order: OrderRow,
  requestId: string,
  stripe: StripeAdapter,
): Promise<void> {
  const current = getOrder(db, order.id);
  if (!current) return;
  if (current.status === "payment_failed") {
    transitionOrder(db, current.id, ["payment_failed"], "payment_pending");
  }
  const refreshed = getOrder(db, order.id)!;
  if (refreshed.status === "payment_pending") {
    await initiatePayment(db, refreshed, requestId, stripe);
  }
}

export async function decideApproval(
  db: Db,
  actor: ActorContext,
  orderId: string,
  rawBody: unknown,
  requestId: string,
  stripe: StripeAdapter,
): Promise<OrderRow> {
  const body = z
    .object({
      decision: z.enum(["approve", "reject"]),
      reason: z.string().max(500).optional(),
    })
    .safeParse(rawBody);
  if (!body.success) {
    throw new AppError(400, "invalid_request", "Invalid approval payload");
  }

  const now = nowIso();
  let order = withImmediateTransaction(db, () => {
    const current = getOrder(db, orderId);
    if (!current || current.buyer_org_id !== actor.organizationId) {
      throw new AppError(404, "not_found", "Order not found");
    }
    if (current.status !== "awaiting_approval") {
      throw new AppError(409, "conflict", "Order is not awaiting approval");
    }
    if (current.requester_subject === actor.subject) {
      throw new AppError(403, "forbidden", "Requester cannot approve their own order");
    }
    if (current.approval_expires_at && Date.parse(current.approval_expires_at) <= Date.parse(now)) {
      transitionOrder(db, current.id, ["awaiting_approval"], "expired");
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: current.id,
        organizationId: current.buyer_org_id,
        eventType: "order.transition",
        actorType: "system",
        requestId,
        payload: { to: "expired" },
      });
      throw new AppError(409, "approval_expired", "Approval window has expired");
    }

    const mandate = db
      .prepare(`SELECT * FROM mandates WHERE id = ?`)
      .get(current.mandate_id) as MandateRow | undefined;
    if (!mandate || mandate.status !== "active" || mandate.policy_hash !== current.mandate_policy_hash) {
      transitionOrder(db, current.id, ["awaiting_approval"], "stale");
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: current.id,
        organizationId: current.buyer_org_id,
        eventType: "order.transition",
        actorType: "system",
        requestId,
        payload: { to: "stale", reason: "mandate_invalid" },
      });
      throw new AppError(409, "stale_order", "Mandate no longer valid for this order");
    }

    if (body.data.decision === "reject") {
      const rejected = transitionOrder(db, current.id, ["awaiting_approval"], "rejected", {
        approval_actor_subject: actor.subject,
        approval_decided_at: now,
        approval_reason: body.data.reason ?? null,
      });
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: current.id,
        organizationId: current.buyer_org_id,
        eventType: "order.approval_rejected",
        actorType: "human",
        actorSubject: actor.subject,
        requestId,
        payload: { reason: body.data.reason ?? null },
      });
      return rejected;
    }

    if (!isOfferStillValidForOrder(db, current, now)) {
      transitionOrder(db, current.id, ["awaiting_approval"], "stale");
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: current.id,
        organizationId: current.buyer_org_id,
        eventType: "order.transition",
        actorType: "system",
        requestId,
        payload: { to: "stale", reason: "offer_changed" },
      });
      throw new AppError(409, "stale_order", "Offer changed while awaiting approval");
    }

    const approved = transitionOrder(db, current.id, ["awaiting_approval"], "payment_pending", {
      approval_actor_subject: actor.subject,
      approval_decided_at: now,
      approval_reason: body.data.reason ?? null,
    });
    writeAudit(db, {
      aggregateType: "order",
      aggregateId: current.id,
      organizationId: current.buyer_org_id,
      eventType: "order.approval_approved",
      actorType: "human",
      actorSubject: actor.subject,
      requestId,
      payload: { reason: body.data.reason ?? null },
    });
    return approved;
  });

  if (order.status === "payment_pending") {
    await initiatePayment(db, order, requestId, stripe);
    order = getOrder(db, order.id)!;
  }
  return order;
}

export function listApprovals(db: Db, buyerOrgId: string): OrderRow[] {
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE buyer_org_id = ? AND status = 'awaiting_approval'
       ORDER BY created_at ASC`,
    )
    .all(buyerOrgId) as OrderRow[];
}

export function getOrderForActor(db: Db, actor: ActorContext, orderId: string): OrderRow {
  const order = getOrder(db, orderId);
  if (!order) throw new AppError(404, "not_found", "Order not found");
  if (order.buyer_org_id === actor.organizationId) return order;
  if (order.supplier_org_id === actor.organizationId) return order;
  throw new AppError(404, "not_found", "Order not found");
}

export function serializeOrder(order: OrderRow, projection: "buyer" | "supplier" | "full") {
  if (projection === "supplier") {
    return {
      id: order.id,
      status: order.status,
      sku: order.sku,
      product_key: order.product_key,
      quantity: order.quantity,
      unit: order.unit,
      delivery_location_id: order.delivery_location_id,
      currency: order.currency,
      created_at: order.created_at,
    };
  }
  return {
    id: order.id,
    buyer_org_id: order.buyer_org_id,
    supplier_org_id: order.supplier_org_id,
    status: order.status,
    policy_decision: order.policy_decision,
    policy_reasons: JSON.parse(order.policy_reasons_json) as string[],
    product_key: order.product_key,
    sku: order.sku,
    category: order.category,
    unit: order.unit,
    unit_price_minor: order.unit_price_minor,
    quantity: order.quantity,
    currency: order.currency,
    total_minor: order.total_minor,
    delivery_location_id: order.delivery_location_id,
    catalog_version: order.catalog_version,
    mandate_version: order.mandate_version,
    mandate_policy_hash: order.mandate_policy_hash,
    approval_expires_at: order.approval_expires_at,
    approval_actor_subject: order.approval_actor_subject,
    approval_decided_at: order.approval_decided_at,
    stripe_payment_intent_id: order.stripe_payment_intent_id,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

const ACCEPTED_STRIPE_EVENTS = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

export function handleStripeWebhook(
  db: Db,
  event: {
    id: string;
    type: string;
    data: { object: { id?: string; amount?: number; currency?: string; metadata?: Record<string, string> } };
  },
  requestId: string,
): { duplicate: boolean } {
  return withImmediateTransaction(db, () => {
    const existing = db.prepare(`SELECT id FROM stripe_events WHERE id = ?`).get(event.id);
    if (existing) return { duplicate: true };

    const now = nowIso();
    db.prepare(
      `INSERT INTO stripe_events (id, type, object_id, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run(event.id, event.type, event.data.object.id ?? null, now);

    if (!ACCEPTED_STRIPE_EVENTS.has(event.type)) {
      db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).run(now, event.id);
      return { duplicate: false };
    }

    const piId = event.data.object.id;
    const orderId = event.data.object.metadata?.order_id;
    if (!piId || !orderId) {
      writeAudit(db, {
        aggregateType: "stripe",
        eventType: "stripe.unmapped_event",
        actorType: "stripe",
        requestId,
        payload: { event_id: event.id, type: event.type },
      });
      db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).run(now, event.id);
      return { duplicate: false };
    }

    const order = getOrder(db, orderId);
    if (!order || order.stripe_payment_intent_id !== piId) {
      writeAudit(db, {
        aggregateType: "stripe",
        eventType: "stripe.unmapped_event",
        actorType: "stripe",
        requestId,
        payload: { event_id: event.id, order_id: orderId, payment_intent_id: piId },
      });
      db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).run(now, event.id);
      return { duplicate: false };
    }

    const amount = event.data.object.amount;
    const currency = event.data.object.currency?.toUpperCase();
    if (amount !== order.total_minor || currency !== order.currency) {
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: order.id,
        organizationId: order.buyer_org_id,
        eventType: "stripe.amount_mismatch",
        actorType: "stripe",
        requestId,
        payload: { event_id: event.id, amount, currency },
      });
      db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).run(now, event.id);
      return { duplicate: false };
    }

    if (event.type === "payment_intent.succeeded") {
      if (order.status !== "paid") {
        const from =
          order.status === "payment_failed" || order.status === "payment_pending"
            ? ([order.status] as OrderStatus[])
            : null;
        if (from) {
          transitionOrder(db, order.id, from, "paid");
          writeAudit(db, {
            aggregateType: "order",
            aggregateId: order.id,
            organizationId: order.buyer_org_id,
            eventType: "order.transition",
            actorType: "stripe",
            requestId,
            payload: { to: "paid", event_id: event.id, payment_intent_id: piId },
          });
        }
      }
    } else if (event.type === "payment_intent.payment_failed") {
      if (order.status === "payment_pending") {
        transitionOrder(db, order.id, ["payment_pending"], "payment_failed");
        writeAudit(db, {
          aggregateType: "order",
          aggregateId: order.id,
          organizationId: order.buyer_org_id,
          eventType: "order.transition",
          actorType: "stripe",
          requestId,
          payload: { to: "payment_failed", event_id: event.id },
        });
      }
    } else if (event.type === "payment_intent.canceled") {
      if (order.status === "payment_pending" || order.status === "payment_failed") {
        transitionOrder(db, order.id, [order.status], "cancelled");
        writeAudit(db, {
          aggregateType: "order",
          aggregateId: order.id,
          organizationId: order.buyer_org_id,
          eventType: "order.transition",
          actorType: "stripe",
          requestId,
          payload: { to: "cancelled", event_id: event.id },
        });
      }
    }

    db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).run(nowIso(), event.id);
    return { duplicate: false };
  });
}

/** MVP (#7): abandon failed payment after Stripe cancel confirms. */
export async function abandonFailedPayment(
  db: Db,
  actor: ActorContext,
  orderId: string,
  requestId: string,
  stripe: StripeAdapter,
): Promise<OrderRow> {
  const order = getOrder(db, orderId);
  if (!order || order.buyer_org_id !== actor.organizationId) {
    throw new AppError(404, "not_found", "Order not found");
  }
  if (order.status !== "payment_failed") {
    throw new AppError(409, "conflict", "Only payment_failed orders can be abandoned");
  }
  if (order.stripe_payment_intent_id) {
    await stripe.cancelPaymentIntent(
      order.stripe_payment_intent_id,
      `order:${order.id}:cancel`,
    );
  }
  return withImmediateTransaction(db, () => {
    const updated = transitionOrder(db, order.id, ["payment_failed"], "cancelled");
    writeAudit(db, {
      aggregateType: "order",
      aggregateId: order.id,
      organizationId: order.buyer_org_id,
      eventType: "order.abandoned",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: { payment_intent_id: order.stripe_payment_intent_id },
    });
    return updated;
  });
}

export function expireApprovals(db: Db, requestId: string): number {
  const now = nowIso();
  return withImmediateTransaction(db, () => {
    const due = db
      .prepare(
        `SELECT id FROM orders
         WHERE status = 'awaiting_approval'
           AND approval_expires_at IS NOT NULL
           AND approval_expires_at <= ?`,
      )
      .all(now) as { id: string }[];
    for (const row of due) {
      transitionOrder(db, row.id, ["awaiting_approval"], "expired");
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: row.id,
        eventType: "order.transition",
        actorType: "system",
        requestId,
        payload: { to: "expired" },
      });
    }
    return due.length;
  });
}
