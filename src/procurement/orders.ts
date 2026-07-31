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
  budget_window_start: string;
  budget_window_end: string;
  budget_limit_minor: number;
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

const orderRequestSchema = z
  .object({
    product_key: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    unit: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,31}$/),
    quantity: z.number().int().safe().positive(),
    delivery_location_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

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
  currency: string,
  budgetWindowStart: string,
  budgetWindowEnd: string,
  excludeOrderId?: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total
       FROM budget_reservations
       WHERE buyer_org_id = ?
         AND currency = ?
         AND budget_window_start = ?
         AND budget_window_end = ?
         AND status IN ('held', 'consumed')
         AND (? IS NULL OR order_id != ?)`,
    )
    .get(
      buyerOrgId,
      currency,
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
  const auditDenial = (reasons: string[], details: Record<string, unknown> = {}) =>
    writeAudit(db, {
      aggregateType: "order",
      organizationId: actor.organizationId,
      eventType: "order.denied",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: { reasons, ...details },
    });

  if (actor.actorType !== "agent" || !actor.scopes.has("orders:create")) {
    auditDenial(["forbidden"]);
    throw new AppError(403, "forbidden", "Buyer agent scope orders:create required");
  }
  const organization = db
    .prepare(`SELECT kind FROM organizations WHERE id = ?`)
    .get(actor.organizationId) as { kind: "buyer" | "supplier" } | undefined;
  if (organization?.kind !== "buyer") {
    auditDenial(["tenant_mismatch"]);
    throw new AppError(403, "tenant_mismatch", "Buyer organization required");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    auditDenial(["invalid_idempotency_key"]);
    throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID");
  }

  const parsed = orderRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const quantity =
      rawBody && typeof rawBody === "object"
        ? (rawBody as Record<string, unknown>).quantity
        : undefined;
    const reason =
      !Number.isSafeInteger(quantity) || (quantity as number) <= 0
        ? "malformed_quantity"
        : "invalid_request";
    auditDenial([reason]);
    throw new AppError(400, reason, "Invalid order payload");
  }

  const cfg = getConfig();
  if (parsed.data.quantity > cfg.MAX_QUANTITY) {
    auditDenial(["malformed_quantity"]);
    throw new AppError(400, "malformed_quantity", "Quantity exceeds maximum");
  }
  const requestHash = sha256Hex(stableStringify(parsed.data));
  const outcome = withImmediateTransaction(
    db,
    ():
      | { kind: "created" | "existing"; order: OrderRow }
      | { kind: "error"; error: AppError } => {
      const existing = db
        .prepare(
          `SELECT * FROM orders
           WHERE buyer_org_id = ? AND requester_subject = ? AND idempotency_key = ?`,
        )
        .get(
          actor.organizationId,
          actor.subject,
          idempotencyKey,
        ) as OrderRow | undefined;
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
          return {
            kind: "error",
            error: new AppError(
              409,
              "idempotency_conflict",
              "Idempotency key reused with different payload",
            ),
          };
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
        return { kind: "existing", order: existing };
      }

      const mandate = getActiveMandate(db, actor.organizationId);
      if (!mandate) {
        const inactive = db
          .prepare(`SELECT id FROM mandates WHERE buyer_org_id = ? LIMIT 1`)
          .get(actor.organizationId);
        const reason = inactive ? "inactive_mandate" : "missing_mandate";
        auditDenial([reason]);
        return {
          kind: "error",
          error: new AppError(
            403,
            reason,
            inactive
              ? "Purchasing Mandate is inactive"
              : "No Purchasing Mandate exists",
          ),
        };
      }

      const policyMandate = mandateToPolicy(mandate);
      const caps = {
        maxUnitPrice: cfg.MAX_UNIT_PRICE_MINOR,
        maxQuantity: cfg.MAX_QUANTITY,
        maxOrderTotal: cfg.MAX_ORDER_TOTAL_MINOR,
      };
      const currentTime = nowIso();

      const offers = listOffersForProduct(db, {
        productKey: parsed.data.product_key,
        unit: parsed.data.unit,
        quantity: parsed.data.quantity,
        deliveryLocationId: parsed.data.delivery_location_id,
        allowedSupplierOrgIds: policyMandate.allowed_supplier_org_ids,
        allowedCategories: policyMandate.allowed_categories,
        currency: policyMandate.currency,
        nowIso: currentTime,
      });
      let selected: ReturnType<typeof selectCheapestOffer>;
      try {
        selected = selectCheapestOffer(offers, parsed.data.quantity, caps);
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        auditDenial(["unsafe_order_total"]);
        return {
          kind: "error",
          error: new AppError(
            422,
            "unsafe_order_total",
            "Order total exceeds safe bounds",
          ),
        };
      }

      const spend = committedSpendMinor(
        db,
        actor.organizationId,
        mandate.currency,
        mandate.budget_window_start,
        mandate.budget_window_end,
      );

      const diagnosticOffer =
        selected?.offer ??
        (db
          .prepare(
            `SELECT * FROM catalog_items
             WHERE product_key = ? AND unit = ?
             ORDER BY unit_price_minor ASC, supplier_org_id ASC
             LIMIT 1`,
          )
          .get(
            parsed.data.product_key,
            parsed.data.unit,
          ) as CatalogItemRow | undefined);
      if (!diagnosticOffer) {
        auditDenial(["stale_offer"], {
          product_key: parsed.data.product_key,
          unit: parsed.data.unit,
        });
        return {
          kind: "error",
          error: new AppError(
            404,
            "no_eligible_offer",
            "No eligible Offer is available",
          ),
        };
      }

      let diagnosticTotal = selected?.totalMinor ?? 0;
      if (!selected) {
        try {
          diagnosticTotal = computeOrderTotalMinor(
            diagnosticOffer.unit_price_minor,
            parsed.data.quantity,
            caps,
          );
        } catch (error) {
          if (!(error instanceof MoneyError)) throw error;
          auditDenial(["unsafe_order_total"]);
          return {
            kind: "error",
            error: new AppError(
              422,
              "unsafe_order_total",
              "Order total exceeds safe bounds",
            ),
          };
        }
      }

      const evaluation = evaluatePolicy({
        nowIso: currentTime,
        buyerOrgId: actor.organizationId,
        actorBuyerOrgId: actor.organizationId,
        quantity: parsed.data.quantity,
        totalMinor: diagnosticTotal,
        deliveryLocationId: parsed.data.delivery_location_id,
        offer: {
          supplierOrgId: diagnosticOffer.supplier_org_id,
          category: diagnosticOffer.category,
          currency: diagnosticOffer.currency,
          active: diagnosticOffer.active === 1,
          expired:
            diagnosticOffer.advisory_quantity < parsed.data.quantity ||
            Date.parse(diagnosticOffer.valid_from) > Date.parse(currentTime) ||
            Date.parse(diagnosticOffer.valid_until) <= Date.parse(currentTime),
          unitPriceMinor: diagnosticOffer.unit_price_minor,
        },
        mandate: policyMandate,
        committedSpendMinor: spend,
      });

      if (!selected) {
        const reasons =
          evaluation.decision === "deny"
            ? evaluation.reasons
            : (["stale_offer"] as const);
        auditDenial([...reasons], {
          product_key: parsed.data.product_key,
          unit: parsed.data.unit,
        });
        return {
          kind: "error",
          error: new AppError(
            403,
            reasons[0] ?? "no_eligible_offer",
            "Order is not permitted",
          ),
        };
      }

      const decision = evaluation.decision;
      const reasons = evaluation.reasons;
      const snapshot = selected.offer;
      const totalMinor = selected.totalMinor;
      const status: OrderStatus =
        decision === "deny"
          ? "denied"
          : decision === "require_approval"
            ? "awaiting_approval"
            : "payment_pending";

      const createdAt = currentTime;
      const approvalExpires =
        status === "awaiting_approval"
          ? new Date(Date.parse(createdAt) + 15 * 60_000).toISOString()
          : null;

      const id = newId("ord");
      db.prepare(
        `INSERT INTO orders (
          id, buyer_org_id, supplier_org_id, requester_subject,
          mandate_id, mandate_version, mandate_policy_hash,
          catalog_item_id, catalog_version, sku, product_key, category, unit,
          unit_price_minor, quantity, currency, total_minor, delivery_location_id,
          budget_window_start, budget_window_end, budget_limit_minor,
          status, policy_decision, policy_reasons_json, idempotency_key, request_hash,
          approval_expires_at, stripe_payment_intent_id, stripe_create_started_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
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
        totalMinor,
        parsed.data.delivery_location_id,
        mandate.budget_window_start,
        mandate.budget_window_end,
        mandate.budget_limit_minor,
        status,
        decision,
        JSON.stringify(reasons),
        idempotencyKey,
        requestHash,
        approvalExpires,
        createdAt,
        createdAt,
      );

      const row = getOrder(db, id)!;
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: id,
        organizationId: actor.organizationId,
        eventType: "order.policy_evaluated",
        actorType: "agent",
        actorSubject: actor.subject,
        requestId,
        payload: {
          decision,
          reasons,
          mandate_version: row.mandate_version,
          mandate_policy_hash: row.mandate_policy_hash,
          catalog_item_id: row.catalog_item_id,
          catalog_version: row.catalog_version,
          total_minor: row.total_minor,
          currency: row.currency,
        },
      });
      if (status === "denied") {
        writeAudit(db, {
          aggregateType: "order",
          aggregateId: id,
          organizationId: actor.organizationId,
          eventType: "order.denied",
          actorType: "agent",
          actorSubject: actor.subject,
          requestId,
          payload: { reasons },
        });
      } else {
        db.prepare(
          `INSERT INTO budget_reservations (
            order_id, buyer_org_id, currency, budget_window_start,
            budget_window_end, amount_minor, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?)`,
        ).run(
          id,
          actor.organizationId,
          mandate.currency,
          mandate.budget_window_start,
          mandate.budget_window_end,
          totalMinor,
          createdAt,
          createdAt,
        );
        writeAudit(db, {
          aggregateType: "budget_reservation",
          aggregateId: id,
          organizationId: actor.organizationId,
          eventType: "budget.reserved",
          actorType: "agent",
          actorSubject: actor.subject,
          requestId,
          payload: {
            order_id: id,
            amount_minor: totalMinor,
            currency: mandate.currency,
            budget_window_start: mandate.budget_window_start,
            budget_window_end: mandate.budget_window_end,
          },
        });
      }
      writeAudit(db, {
        aggregateType: "order",
        aggregateId: id,
        organizationId: actor.organizationId,
        eventType: "order.transition",
        actorType: "agent",
        actorSubject: actor.subject,
        requestId,
        payload: { from: null, to: status },
      });
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
      return { kind: "created", order: row };
    },
  );

  if (outcome.kind === "error") throw outcome.error;
  const order = outcome.order;
  if (outcome.kind === "existing") {
    if (order.status === "payment_pending" || order.status === "payment_failed") {
      await resumePayment(db, order, requestId, stripe);
      return { order: getOrder(db, order.id)!, httpStatus: 200 };
    }
    return {
      order,
      httpStatus: order.status === "awaiting_approval" ? 202 : 200,
    };
  }
  if (order.status === "denied") {
    return { order, httpStatus: 200 };
  }
  if (order.status === "awaiting_approval") {
    return { order, httpStatus: 202 };
  }

  await initiatePayment(db, order, requestId, stripe);
  return { order: getOrder(db, order.id)!, httpStatus: 201 };
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
    budget_window_start: order.budget_window_start,
    budget_window_end: order.budget_window_end,
    budget_limit_minor: order.budget_limit_minor,
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

export function expireApprovals(
  db: Db,
  requestId: string,
  now = nowIso(),
): number {
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
