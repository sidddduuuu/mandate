import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { AuthError, type ActorContext } from "../auth/context.ts";
import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError, parseRequest } from "../http.ts";
import {
  mandatePolicySchema,
  type MandatePolicyData,
} from "./mandates.ts";
import {
  POLICY_CAPS,
  evaluatePolicy,
  type PolicyDecision,
} from "./policy.ts";
import {
  reserveOffer,
  selectOffer,
  type ReservableOffer as Offer,
} from "./reservations.ts";

const identifier = z.string().trim().min(1).max(128);
const orderInputSchema = z.object({
  productKey: identifier,
  unit: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(POLICY_CAPS.quantity),
  deliveryLocationId: identifier,
}).strict();
const idempotencyKeySchema = z.string().uuid()
  .transform((value) => value.toLowerCase());
const nonPersistedReasonSchema = z.enum([
  "MANDATE_MISSING",
  "MANDATE_INACTIVE",
  "MANDATE_INVALID",
  "NO_ELIGIBLE_OFFER",
]);
const storedDenialSchema = z.object({
  requestHash: z.string().length(64),
  reasonCodes: z.array(nonPersistedReasonSchema).min(1),
  createdAt: z.string(),
}).strict();
const APPROVAL_TTL_MS = 30 * 60 * 1_000;
const BUYER_ORDER_COLUMNS = `
  id, buyer_organization_id, supplier_organization_id, requester_subject,
  mandate_id, mandate_version, mandate_hash, catalog_item_id,
  catalog_item_version, sku, product_key, category, unit, unit_price, quantity,
  currency, total, delivery_location_id, status, policy_decision,
  policy_reasons_json, approval_expires_at, approval_actor_subject,
  approval_decided_at, approval_reason, created_at, updated_at
`;

type OrderStatus =
  | "denied"
  | "awaiting_approval"
  | "payment_pending"
  | "paid"
  | "payment_failed"
  | "rejected"
  | "stale"
  | "expired"
  | "cancelled";

export type BuyerOrder = Readonly<{
  view: "buyer";
  id: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  requesterSubject: string;
  mandateId: string;
  mandateVersion: number;
  mandateHash: string;
  catalogItemId: string;
  catalogItemVersion: number;
  sku: string;
  productKey: string;
  category: string;
  unit: string;
  unitPriceMinor: number;
  quantity: number;
  currency: string;
  totalMinor: number;
  deliveryLocationId: string;
  status: OrderStatus;
  policyDecision: PolicyDecision;
  policyReasonCodes: readonly string[];
  approvalExpiresAt: string | null;
  approvalActorSubject: string | null;
  approvalDecidedAt: string | null;
  approvalReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type FulfillmentOrder = Readonly<{
  view: "fulfillment";
  id: string;
  status: OrderStatus;
  sku: string;
  productKey: string;
  unit: string;
  quantity: number;
  deliveryLocationId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type OrderDenial = Readonly<{
  status: "denied";
  policyDecision: "deny";
  policyReasonCodes: readonly (
    | "MANDATE_MISSING"
    | "MANDATE_INACTIVE"
    | "MANDATE_INVALID"
    | "NO_ELIGIBLE_OFFER"
  )[];
  idempotencyKey: string;
  createdAt: string;
}>;

export type CreateOrderResult =
  | Readonly<{ kind: "order"; replayed: boolean; order: BuyerOrder }>
  | Readonly<{ kind: "denial"; replayed: boolean; denial: OrderDenial }>;

type OrderInput = z.output<typeof orderInputSchema>;
type Mandate = Readonly<{
  id: string;
  version: number;
  hash: string;
  validFrom: string;
  validUntil: string;
  policy: MandatePolicyData;
}>;
type Conflict = Readonly<{ conflict: true }>;
type StoredDenial = z.output<typeof storedDenialSchema>;
type PriorRecord =
  | Readonly<{
      order: Record<string, unknown>; denial: null; requestHash: string;
      aggregateType: "order"; aggregateId: string;
    }>
  | Readonly<{
      order: null; denial: StoredDenial; requestHash: string;
      aggregateType: "order_request"; aggregateId: string;
    }>;
type EvaluatedOrder = Readonly<{
  evaluation: ReturnType<typeof evaluatePolicy>; remainingBudgetMinor: number;
}>;
type NewOrderState = EvaluatedOrder & Readonly<{
  id: string; status: "denied" | "awaiting_approval" | "payment_pending";
  approvalExpiresAt: string | null;
}>;

async function requireBuyer(
  database: Database,
  actor: ActorContext,
): Promise<string> {
  if (
    actor.actorType !== "buyer_agent"
    || !actor.scopes.includes("orders:create")
  ) throw new AuthError("forbidden");
  const organization = await database.get(
    `SELECT id, kind FROM organizations
     WHERE auth0_org_id = ? FOR UPDATE`,
    actor.organizationId,
  );
  if (typeof organization?.id !== "string" || organization.kind !== "buyer")
    throw new AuthError("forbidden");
  return organization.id;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function buyerOrder(row: Record<string, unknown>): BuyerOrder {
  const reasons: unknown = JSON.parse(String(row.policy_reasons_json));
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string"))
    throw new Error("Stored order policy reasons are invalid");
  return Object.freeze({
    view: "buyer",
    id: String(row.id),
    buyerOrganizationId: String(row.buyer_organization_id),
    supplierOrganizationId: String(row.supplier_organization_id),
    requesterSubject: String(row.requester_subject),
    mandateId: String(row.mandate_id),
    mandateVersion: Number(row.mandate_version),
    mandateHash: String(row.mandate_hash),
    catalogItemId: String(row.catalog_item_id),
    catalogItemVersion: Number(row.catalog_item_version),
    sku: String(row.sku),
    productKey: String(row.product_key),
    category: String(row.category),
    unit: String(row.unit),
    unitPriceMinor: Number(row.unit_price),
    quantity: Number(row.quantity),
    currency: String(row.currency),
    totalMinor: Number(row.total),
    deliveryLocationId: String(row.delivery_location_id),
    status: String(row.status) as OrderStatus,
    policyDecision: String(row.policy_decision) as PolicyDecision,
    policyReasonCodes: Object.freeze([...reasons]) as readonly string[],
    approvalExpiresAt: nullableString(row.approval_expires_at),
    approvalActorSubject: nullableString(row.approval_actor_subject),
    approvalDecidedAt: nullableString(row.approval_decided_at),
    approvalReason: nullableString(row.approval_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function fulfillmentOrder(row: Record<string, unknown>): FulfillmentOrder {
  return Object.freeze({
    view: "fulfillment",
    id: String(row.id),
    status: String(row.status) as OrderStatus,
    sku: String(row.sku),
    productKey: String(row.product_key),
    unit: String(row.unit),
    quantity: Number(row.quantity),
    deliveryLocationId: String(row.delivery_location_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

async function audit(
  database: Database,
  actor: ActorContext,
  organizationId: string,
  aggregateType: string,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    aggregateType, aggregateId, organizationId, eventType, actor.actorType,
    actor.subject, requestId, JSON.stringify(payload), createdAt,
  );
}

function canonicalRequest(input: OrderInput): string {
  return JSON.stringify({
    deliveryLocationId: input.deliveryLocationId,
    productKey: input.productKey,
    quantity: input.quantity,
    unit: input.unit,
  });
}

async function loadMandate(
  database: Database,
  buyerOrganizationId: string,
): Promise<Mandate | "invalid" | null> {
  const row = await database.get(`
    SELECT id, version, policy_hash, valid_from, valid_until, policy_json,
      schema_version
    FROM mandates
    WHERE buyer_organization_id = ? AND state = 'active'
  `, buyerOrganizationId);
  if (!row) return null;
  if (row.schema_version !== 1) return "invalid";
  try {
    const parsed = mandatePolicySchema.safeParse(
      JSON.parse(String(row.policy_json)),
    );
    if (!parsed.success) return "invalid";
    return Object.freeze({
      id: String(row.id),
      version: Number(row.version),
      hash: String(row.policy_hash),
      validFrom: String(row.valid_from),
      validUntil: String(row.valid_until),
      policy: parsed.data,
    });
  } catch {
    return "invalid";
  }
}

function mandateIsActive(mandate: Mandate, now: string): boolean {
  return (
    mandate.validFrom <= now
    && mandate.validUntil > now
    && mandate.policy.budgetWindow.start <= now
    && mandate.policy.budgetWindow.end > now
  );
}

async function remainingBudget(
  database: Database,
  buyerOrganizationId: string,
  policy: MandatePolicyData,
  now: string,
): Promise<number> {
  const rows = await database.all(`
    SELECT total FROM orders
    WHERE buyer_organization_id = ?
      AND currency = ?
      AND created_at >= ? AND created_at < ?
      AND (
        status IN ('payment_pending', 'payment_failed', 'paid')
        OR (status = 'awaiting_approval' AND approval_expires_at > ?)
      )
  `,
    buyerOrganizationId,
    policy.currency,
    policy.budgetWindow.start,
    policy.budgetWindow.end,
    now,
  );
  let committed = 0;
  // ponytail: stop once exhausted; use a balance ledger if order volume grows.
  for (const row of rows) {
    committed += Number(row.total);
    if (committed > policy.budgetWindow.limitMinor) return -1;
  }
  return policy.budgetWindow.limitMinor - committed;
}

function denial(
  idempotencyKey: string,
  reasonCodes: OrderDenial["policyReasonCodes"],
  createdAt: string,
): OrderDenial {
  return Object.freeze({
    status: "denied",
    policyDecision: "deny",
    policyReasonCodes: Object.freeze([...reasonCodes]),
    idempotencyKey,
    createdAt,
  });
}

async function denyWithoutSnapshot(
  database: Database,
  actor: ActorContext,
  buyerOrganizationId: string,
  idempotencyKey: string,
  requestHash: string,
  requestId: string,
  reasonCodes: OrderDenial["policyReasonCodes"],
  createdAt: string,
): Promise<CreateOrderResult> {
  await database.run(`
    INSERT INTO order_denials (
      buyer_organization_id, requester_subject, idempotency_key, request_hash,
      policy_reasons_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
    buyerOrganizationId, actor.subject, idempotencyKey, requestHash,
    JSON.stringify(reasonCodes), createdAt,
  );
  await audit(
    database, actor, buyerOrganizationId, "order_request", idempotencyKey,
    "order.denied", requestId, { requestHash, reasonCodes, createdAt },
    createdAt,
  );
  return Object.freeze({
    kind: "denial",
    replayed: false,
    denial: denial(idempotencyKey, reasonCodes, createdAt),
  });
}

async function loadPrior(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  idempotencyKey: string,
): Promise<PriorRecord | null> {
  const order = await database.get(`
    SELECT request_hash, ${BUYER_ORDER_COLUMNS} FROM orders
    WHERE buyer_organization_id = ? AND requester_subject = ?
      AND idempotency_key = ?
  `, buyerOrganizationId, actor.subject, idempotencyKey);
  if (order)
    return Object.freeze({
      order,
      denial: null,
      requestHash: String(order.request_hash),
      aggregateType: "order",
      aggregateId: String(order.id),
    });
  const stored = await database.get(`
    SELECT request_hash, policy_reasons_json, created_at
    FROM order_denials
    WHERE buyer_organization_id = ? AND requester_subject = ?
      AND idempotency_key = ?
  `, buyerOrganizationId, actor.subject, idempotencyKey);
  if (!stored) return null;
  const storedDenial = storedDenialSchema.parse({
    requestHash: String(stored.request_hash),
    reasonCodes: JSON.parse(String(stored.policy_reasons_json)),
    createdAt: String(stored.created_at),
  });
  return Object.freeze({
    order: null,
    denial: storedDenial,
    requestHash: storedDenial.requestHash,
    aggregateType: "order_request",
    aggregateId: idempotencyKey,
  });
}

async function priorResult(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  idempotencyKey: string, requestHash: string, requestId: string,
  createdAt: string,
): Promise<CreateOrderResult | Conflict | null> {
  const prior = await loadPrior(
    database, actor, buyerOrganizationId, idempotencyKey,
  );
  if (!prior) return null;
  if (prior.requestHash !== requestHash) {
    await audit(
      database, actor, buyerOrganizationId, prior.aggregateType,
      prior.aggregateId,
      "order.idempotency_conflict", requestId,
      {
        originalRequestHash: prior.requestHash,
        attemptedRequestHash: requestHash,
      },
      createdAt,
    );
    return Object.freeze({ conflict: true });
  }
  await audit(
    database, actor, buyerOrganizationId, prior.aggregateType,
    prior.aggregateId,
    "order.idempotent_replay", requestId, { requestHash }, createdAt,
  );
  if (prior.order) {
    return Object.freeze({
      kind: "order",
      replayed: true,
      order: buyerOrder(prior.order),
    });
  }
  return Object.freeze({
    kind: "denial",
    replayed: true,
    denial: denial(
      idempotencyKey,
      prior.denial.reasonCodes,
      prior.denial.createdAt,
    ),
  });
}

async function evaluateSelectedOrder(
  database: Database, buyerOrganizationId: string, input: OrderInput,
  mandate: Mandate, offer: Offer, now: string,
): Promise<EvaluatedOrder> {
  const remainingBudgetMinor = await remainingBudget(
    database, buyerOrganizationId, mandate.policy, now,
  );
  const evaluation = evaluatePolicy({
    buyerOrgId: buyerOrganizationId,
    quantity: input.quantity,
    deliveryLocationId: input.deliveryLocationId,
    remainingBudgetMinor,
    offer: {
      supplierOrgId: offer.supplierOrganizationId,
      category: offer.category,
      currency: offer.currency,
      unitPriceMinor: offer.unitPriceMinor,
      active: true,
      unexpired: true,
    },
    mandate: {
      buyerOrgId: buyerOrganizationId,
      active: mandateIsActive(mandate, now),
      currency: mandate.policy.currency,
      autonomousOrderLimitMinor: mandate.policy.autonomousOrderLimitMinor,
      hardExceptionLimitMinor: mandate.policy.hardExceptionLimitMinor,
      allowedSupplierOrgIds: mandate.policy.allowedSupplierOrgIds,
      allowedCategories: mandate.policy.allowedCategories,
      allowedDeliveryLocationIds: mandate.policy.allowedDeliveryLocationIds,
    },
  });
  if (evaluation.orderTotalMinor === null)
    throw new Error("Selected offer could not be priced");
  return Object.freeze({ evaluation, remainingBudgetMinor });
}

function newOrderState(
  evaluated: EvaluatedOrder, mandate: Mandate, now: string,
): NewOrderState {
  const { evaluation } = evaluated;
  const status = evaluation.decision === "deny"
    ? "denied"
    : evaluation.decision === "require_approval"
      ? "awaiting_approval"
      : "payment_pending";
  const approvalExpiresAt = evaluation.decision === "require_approval"
    ? new Date(Math.min(
      Date.parse(now) + APPROVAL_TTL_MS,
      Date.parse(mandate.validUntil),
      Date.parse(mandate.policy.budgetWindow.end),
    )).toISOString()
    : null;
  return Object.freeze({
    ...evaluated, id: randomUUID(), status, approvalExpiresAt,
  });
}

async function insertOrder(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  input: OrderInput, idempotencyKey: string, requestHash: string,
  mandate: Mandate, offer: Offer, state: NewOrderState, now: string,
): Promise<void> {
  await database.run(`
    INSERT INTO orders (
      id, buyer_organization_id, supplier_organization_id, requester_subject,
      mandate_id, mandate_version, mandate_hash, catalog_item_id,
      catalog_item_version, sku, product_key, category, unit, unit_price,
      quantity, currency, total, delivery_location_id, status, policy_decision,
      policy_reasons_json, idempotency_key, request_hash, approval_expires_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `,
    state.id, buyerOrganizationId, offer.supplierOrganizationId, actor.subject,
    mandate.id, mandate.version, mandate.hash, offer.id, offer.version,
    offer.sku, offer.productKey, offer.category, offer.unit,
    offer.unitPriceMinor, input.quantity, offer.currency,
    state.evaluation.orderTotalMinor, input.deliveryLocationId, state.status,
    state.evaluation.decision, JSON.stringify(state.evaluation.reasonCodes),
    idempotencyKey, requestHash, state.approvalExpiresAt, now, now,
  );
}

async function auditSelectedOffer(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  input: OrderInput, requestId: string, offer: Offer, state: NewOrderState,
  now: string,
): Promise<void> {
  await audit(
    database, actor, buyerOrganizationId, "order", state.id,
    "offer.selected", requestId,
    {
      catalogItemId: offer.id,
      catalogItemVersion: offer.version,
      supplierOrganizationId: offer.supplierOrganizationId,
      unitPriceMinor: offer.unitPriceMinor,
      quantity: input.quantity,
      totalMinor: state.evaluation.orderTotalMinor,
      currency: offer.currency,
    },
    now,
  );
}

async function auditPolicyDecision(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  requestId: string, mandate: Mandate, state: NewOrderState, now: string,
): Promise<void> {
  await audit(
    database, actor, buyerOrganizationId, "order", state.id,
    "policy.evaluated", requestId,
    {
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      mandateHash: mandate.hash,
      decision: state.evaluation.decision,
      reasonCodes: state.evaluation.reasonCodes,
      remainingBudgetMinor: state.remainingBudgetMinor,
    },
    now,
  );
}

async function auditCreatedOrder(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  input: OrderInput, requestId: string, mandate: Mandate, offer: Offer,
  state: NewOrderState, now: string,
): Promise<void> {
  await audit(
    database, actor, buyerOrganizationId, "order", state.id, "order.created",
    requestId,
    {
      status: state.status,
      policyDecision: state.evaluation.decision,
      policyReasonCodes: state.evaluation.reasonCodes,
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      mandateHash: mandate.hash,
      catalogItemId: offer.id,
      catalogItemVersion: offer.version,
      supplierOrganizationId: offer.supplierOrganizationId,
      unitPriceMinor: offer.unitPriceMinor,
      quantity: input.quantity,
      totalMinor: state.evaluation.orderTotalMinor,
      currency: offer.currency,
      deliveryLocationId: input.deliveryLocationId,
      approvalExpiresAt: state.approvalExpiresAt,
    },
    now,
  );
}

async function createdOrderResult(
  database: Database, id: string,
): Promise<CreateOrderResult> {
  const row = await database.get(
    `SELECT ${BUYER_ORDER_COLUMNS} FROM orders WHERE id = ?`,
    id,
  );
  if (!row) throw new Error("Created order could not be read");
  return Object.freeze({
    kind: "order",
    replayed: false,
    order: buyerOrder(row),
  });
}

async function persistOrder(
  database: Database, actor: ActorContext, buyerOrganizationId: string,
  input: OrderInput, idempotencyKey: string, requestHash: string,
  requestId: string, mandate: Mandate, offer: Offer, now: string,
): Promise<CreateOrderResult> {
  const evaluated = await evaluateSelectedOrder(
    database, buyerOrganizationId, input, mandate, offer, now,
  );
  const state = newOrderState(evaluated, mandate, now);
  if (
    state.status !== "denied"
    && !await reserveOffer(database, state.id, {
      id: offer.id,
      version: offer.version,
      quantity: input.quantity,
    }, now)
  ) {
    return denyWithoutSnapshot(
      database,
      actor,
      buyerOrganizationId,
      idempotencyKey,
      requestHash,
      requestId,
      ["NO_ELIGIBLE_OFFER"],
      now,
    );
  }
  await insertOrder(
    database, actor, buyerOrganizationId, input, idempotencyKey, requestHash,
    mandate, offer, state, now,
  );
  await auditSelectedOffer(
    database, actor, buyerOrganizationId, input, requestId, offer, state, now,
  );
  await auditPolicyDecision(
    database, actor, buyerOrganizationId, requestId, mandate, state, now,
  );
  await auditCreatedOrder(
    database, actor, buyerOrganizationId, input, requestId, mandate, offer,
    state, now,
  );
  return createdOrderResult(database, state.id);
}

export async function createOrder(
  database: Database, actor: ActorContext, input: unknown,
  idempotencyKey: string, requestId: string, now = new Date(),
): Promise<CreateOrderResult> {
  const parsed = parseRequest(orderInputSchema, input);
  const key = parseRequest(idempotencyKeySchema, idempotencyKey);
  const createdAt = now.toISOString();
  const requestHash = createHash("sha256").update(canonicalRequest(parsed))
    .digest("hex");
  const outcome = await withImmediateTransaction(database, async (transaction) => {
    const buyerOrganizationId = await requireBuyer(transaction, actor);
    const prior = await priorResult(
      transaction, actor, buyerOrganizationId, key, requestHash, requestId,
      createdAt,
    );
    if (prior) return prior;
    const mandate = await loadMandate(transaction, buyerOrganizationId);
    if (!mandate)
      return denyWithoutSnapshot(
        transaction, actor, buyerOrganizationId, key, requestHash, requestId,
        ["MANDATE_MISSING"], createdAt,
      );
    if (mandate === "invalid")
      return denyWithoutSnapshot(
        transaction, actor, buyerOrganizationId, key, requestHash, requestId,
        ["MANDATE_INVALID"], createdAt,
      );
    if (!mandateIsActive(mandate, createdAt))
      return denyWithoutSnapshot(
        transaction, actor, buyerOrganizationId, key, requestHash, requestId,
        ["MANDATE_INACTIVE"], createdAt,
      );
    const offer = await selectOffer(
      transaction,
      parsed,
      mandate.policy,
      createdAt,
    );
    if (!offer)
      return denyWithoutSnapshot(
        transaction, actor, buyerOrganizationId, key, requestHash, requestId,
        ["NO_ELIGIBLE_OFFER"], createdAt,
      );
    return persistOrder(
      transaction, actor, buyerOrganizationId, parsed, key, requestHash,
      requestId, mandate, offer, createdAt,
    );
  });
  if ("conflict" in outcome) throw new ApiError(
    409, "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used for a different request",
  );
  return outcome;
}

async function readOrganization(
  database: Database,
  actor: ActorContext,
): Promise<Readonly<{ id: string; kind: "buyer" | "supplier" }>> {
  if (
    !actor.scopes.includes("orders:read")
    || !["buyer_agent", "supplier_agent", "human"].includes(actor.actorType)
  ) throw new AuthError("forbidden");
  const row = await database.get(
    "SELECT id, kind FROM organizations WHERE auth0_org_id = ?",
    actor.organizationId,
  );
  if (
    typeof row?.id !== "string"
    || (row.kind !== "buyer" && row.kind !== "supplier")
    || (actor.actorType === "supplier_agent") !== (row.kind === "supplier")
  ) throw new AuthError("forbidden");
  return Object.freeze({ id: row.id, kind: row.kind });
}

export async function getOrder(
  database: Database,
  actor: ActorContext,
  orderId: string,
): Promise<BuyerOrder | FulfillmentOrder> {
  const organization = await readOrganization(database, actor);
  const validId = identifier.safeParse(orderId);
  if (!validId.success)
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  const row = organization.kind === "buyer"
    ? await database.get(`
        SELECT ${BUYER_ORDER_COLUMNS} FROM orders
        WHERE id = ? AND buyer_organization_id = ?
      `, validId.data, organization.id)
    : await database.get(`
        SELECT id, status, sku, product_key, unit, quantity,
          delivery_location_id, created_at, updated_at
        FROM orders
        WHERE id = ? AND supplier_organization_id = ? AND status = 'paid'
      `, validId.data, organization.id);
  if (!row) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  return organization.kind === "buyer"
    ? buyerOrder(row)
    : fulfillmentOrder(row);
}
