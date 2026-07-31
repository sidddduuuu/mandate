import { z } from "zod";

import { AuthError, type ActorContext } from "../auth/context.ts";
import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError, parseRequest } from "../http.ts";
import { mandatePolicySchema } from "./mandates.ts";

const identifier = z.string().trim().min(1).max(128);
const approvalInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(1_000).optional(),
}).strict();

type ApprovalInput = z.output<typeof approvalInputSchema>;

export type PendingApproval = Readonly<{
  id: string;
  requesterSubject: string;
  supplierOrganizationId: string;
  mandateVersion: number;
  mandateHash: string;
  sku: string;
  productKey: string;
  category: string;
  unit: string;
  unitPriceMinor: number;
  quantity: number;
  currency: string;
  totalMinor: number;
  deliveryLocationId: string;
  policyReasonCodes: readonly string[];
  approvalExpiresAt: string;
  createdAt: string;
}>;

export type ApprovalDecision = Readonly<{
  id: string;
  status:
    | "payment_pending"
    | "paid"
    | "payment_failed"
    | "cancelled"
    | "rejected";
  approvalActorSubject: string;
  approvalDecidedAt: string;
  approvalReason: string | null;
}>;

export type ApprovalResult = Readonly<{
  approval: ApprovalDecision;
  replayed: boolean;
  initiatePayment: boolean;
}>;

export type ApprovalState = Readonly<{
  id: string;
  status: string;
}>;

type StoredOrder = Readonly<{
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
  deliveryLocationId: string;
  status: string;
  approvalExpiresAt: string;
  approvalActorSubject: string | null;
  approvalDecidedAt: string | null;
  approvalReason: string | null;
}>;

async function buyerOrganization(
  database: Database,
  actor: ActorContext,
  permission: "approvals:read" | "approvals:decide",
): Promise<string> {
  if (actor.actorType !== "human" || !actor.scopes.includes(permission)) {
    throw new AuthError("forbidden");
  }
  const row = await database.get(
    "SELECT id, kind FROM organizations WHERE auth0_org_id = ?",
    actor.organizationId,
  );
  if (typeof row?.id !== "string" || row.kind !== "buyer") {
    throw new AuthError("forbidden");
  }
  return row.id;
}

function stringReasons(value: unknown): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("Stored policy reasons are invalid");
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((reason) => typeof reason !== "string")
  ) throw new Error("Stored policy reasons are invalid");
  return Object.freeze([...parsed]);
}

function pendingApproval(row: Record<string, unknown>): PendingApproval {
  return Object.freeze({
    id: String(row.id),
    requesterSubject: String(row.requester_subject),
    supplierOrganizationId: String(row.supplier_organization_id),
    mandateVersion: Number(row.mandate_version),
    mandateHash: String(row.mandate_hash),
    sku: String(row.sku),
    productKey: String(row.product_key),
    category: String(row.category),
    unit: String(row.unit),
    unitPriceMinor: Number(row.unit_price),
    quantity: Number(row.quantity),
    currency: String(row.currency),
    totalMinor: Number(row.total),
    deliveryLocationId: String(row.delivery_location_id),
    policyReasonCodes: stringReasons(row.policy_reasons_json),
    approvalExpiresAt: String(row.approval_expires_at),
    createdAt: String(row.created_at),
  });
}

export async function listPendingApprovals(
  database: Database,
  actor: ActorContext,
  now = new Date(),
): Promise<readonly PendingApproval[]> {
  const buyerOrganizationId = await buyerOrganization(
    database,
    actor,
    "approvals:read",
  );
  const rows = await database.all(`
    SELECT id, requester_subject, supplier_organization_id, mandate_version,
      mandate_hash, sku, product_key, category, unit, unit_price, quantity,
      currency, total, delivery_location_id, policy_reasons_json,
      approval_expires_at, created_at
    FROM orders
    WHERE buyer_organization_id = ? AND status = 'awaiting_approval'
      AND approval_expires_at > ?
    ORDER BY created_at, id
  `, buyerOrganizationId, now.toISOString());
  return Object.freeze(rows.map(pendingApproval));
}

export async function getApprovalDecision(
  database: Database,
  actor: ActorContext,
  orderId: string,
): Promise<ApprovalState> {
  const id = identifier.safeParse(orderId);
  if (!id.success) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  const buyerOrganizationId = await buyerOrganization(
    database,
    actor,
    "approvals:read",
  );
  const row = await database.get(
    "SELECT id, status FROM orders WHERE id = ? AND buyer_organization_id = ?",
    id.data,
    buyerOrganizationId,
  );
  if (!row) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  return Object.freeze({ id: String(row.id), status: String(row.status) });
}

function storedOrder(row: Record<string, unknown>): StoredOrder {
  return Object.freeze({
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
    deliveryLocationId: String(row.delivery_location_id),
    status: String(row.status),
    approvalExpiresAt: String(row.approval_expires_at),
    approvalActorSubject:
      typeof row.approval_actor_subject === "string"
        ? row.approval_actor_subject
        : null,
    approvalDecidedAt:
      typeof row.approval_decided_at === "string"
        ? row.approval_decided_at
        : null,
    approvalReason:
      typeof row.approval_reason === "string" ? row.approval_reason : null,
  });
}

async function readOrder(
  database: Database,
  buyerOrganizationId: string,
  orderId: string,
): Promise<StoredOrder> {
  const row = await database.get(`
    SELECT id, buyer_organization_id, supplier_organization_id,
      requester_subject, mandate_id, mandate_version, mandate_hash,
      catalog_item_id, catalog_item_version, sku, product_key, category, unit,
      unit_price, quantity, currency, delivery_location_id, status,
      approval_expires_at, approval_actor_subject, approval_decided_at,
      approval_reason
    FROM orders
    WHERE id = ? AND buyer_organization_id = ?
    FOR UPDATE
  `, orderId, buyerOrganizationId);
  if (!row) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  return storedOrder(row);
}

async function audit(
  database: Database,
  actor: ActorContext,
  order: StoredOrder,
  eventType: string,
  requestId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string,
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (
      aggregate_type, aggregate_id, organization_id, event_type, actor_type,
      actor_subject, request_id, payload_json, created_at
    ) VALUES ('order', ?, ?, ?, 'human', ?, ?, ?, ?)
  `,
    order.id,
    order.buyerOrganizationId,
    eventType,
    actor.subject,
    requestId,
    JSON.stringify(payload),
    createdAt,
  );
}

async function replay(
  database: Database,
  actor: ActorContext,
  order: StoredOrder,
  input: ApprovalInput,
  requestId: string,
  now: string,
): Promise<ApprovalResult | null> {
  const approved = [
    "payment_pending",
    "paid",
    "payment_failed",
    "cancelled",
  ].includes(order.status);
  const sameDecision = input.decision === "approve"
    ? approved
    : order.status === "rejected";
  if (
    !sameDecision
    || order.approvalActorSubject !== actor.subject
    || !order.approvalDecidedAt
  ) return null;
  await audit(
    database,
    actor,
    order,
    "approval.replayed",
    requestId,
    { decision: input.decision, status: order.status },
    now,
  );
  return Object.freeze({
    replayed: true,
    initiatePayment:
      input.decision === "approve" && order.status === "payment_pending",
    approval: Object.freeze({
      id: order.id,
      status: order.status as ApprovalDecision["status"],
      approvalActorSubject: order.approvalActorSubject,
      approvalDecidedAt: order.approvalDecidedAt,
      approvalReason: order.approvalReason,
    }),
  });
}

async function mandateStillApplies(
  database: Database,
  order: StoredOrder,
  now: string,
): Promise<boolean> {
  const row = await database.get(`
    SELECT policy_json, schema_version FROM mandates
    WHERE id = ? AND buyer_organization_id = ? AND version = ?
      AND policy_hash = ? AND state = 'active'
      AND valid_from <= ? AND valid_until > ?
  `,
    order.mandateId,
    order.buyerOrganizationId,
    order.mandateVersion,
    order.mandateHash,
    now,
    now,
  );
  if (row?.schema_version !== 1 || typeof row.policy_json !== "string") {
    return false;
  }
  let rawPolicy: unknown;
  try {
    rawPolicy = JSON.parse(row.policy_json);
  } catch {
    return false;
  }
  const result = mandatePolicySchema.safeParse(rawPolicy);
  if (!result.success) return false;
  const policy = result.data;
  return (
    policy.budgetWindow.start <= now
    && policy.budgetWindow.end > now
    && policy.currency === order.currency
    && policy.allowedSupplierOrgIds.includes(order.supplierOrganizationId)
    && policy.allowedCategories.includes(order.category)
    && policy.allowedDeliveryLocationIds.includes(order.deliveryLocationId)
  );
}

async function offerStillApplies(
  database: Database,
  order: StoredOrder,
  now: string,
): Promise<boolean> {
  const row = await database.get(`
    SELECT version, sku, product_key, category, unit, unit_price, currency,
      advisory_quantity, active, valid_from, valid_until
    FROM catalog_items
    WHERE id = ? AND supplier_organization_id = ?
  `, order.catalogItemId, order.supplierOrganizationId);
  return Boolean(
    row
    && row.active === 1
    && typeof row.valid_from === "string"
    && row.valid_from <= now
    && typeof row.valid_until === "string"
    && row.valid_until > now
    && Number(row.advisory_quantity) >= order.quantity
    && Number(row.version) === order.catalogItemVersion
    && row.sku === order.sku
    && row.product_key === order.productKey
    && row.category === order.category
    && row.unit === order.unit
    && Number(row.unit_price) === order.unitPriceMinor
    && row.currency === order.currency
  );
}

async function transitionWithoutDecision(
  database: Database,
  actor: ActorContext,
  order: StoredOrder,
  status: "expired" | "stale",
  requestId: string,
  now: string,
): Promise<void> {
  const updated = await database.run(`
    UPDATE orders SET status = ?, updated_at = ?
    WHERE id = ? AND buyer_organization_id = ?
      AND status = 'awaiting_approval'
  `, status, now, order.id, order.buyerOrganizationId);
  if (updated.changes !== 1) {
    throw new Error("Approval transition lost its compare-and-set");
  }
  await audit(
    database,
    actor,
    order,
    `order.${status}`,
    requestId,
    { fromStatus: "awaiting_approval", toStatus: status },
    now,
  );
}

async function decide(
  database: Database,
  actor: ActorContext,
  order: StoredOrder,
  input: ApprovalInput,
  requestId: string,
  now: string,
): Promise<ApprovalResult> {
  const status = input.decision === "approve" ? "payment_pending" : "rejected";
  const reason = input.reason || null;
  const updated = await database.run(`
    UPDATE orders SET status = ?, approval_actor_subject = ?,
      approval_decided_at = ?, approval_reason = ?, updated_at = ?
    WHERE id = ? AND buyer_organization_id = ?
      AND status = 'awaiting_approval'
  `,
    status,
    actor.subject,
    now,
    reason,
    now,
    order.id,
    order.buyerOrganizationId,
  );
  if (updated.changes !== 1) {
    throw new Error("Approval transition lost its compare-and-set");
  }
  await audit(
    database,
    actor,
    order,
    input.decision === "approve" ? "approval.approved" : "approval.rejected",
    requestId,
    {
      decision: input.decision,
      fromStatus: "awaiting_approval",
      toStatus: status,
      reason,
    },
    now,
  );
  return Object.freeze({
    replayed: false,
    initiatePayment: input.decision === "approve",
    approval: Object.freeze({
      id: order.id,
      status,
      approvalActorSubject: actor.subject,
      approvalDecidedAt: now,
      approvalReason: reason,
    }),
  });
}

export async function decideApproval(
  database: Database,
  actor: ActorContext,
  orderId: string,
  input: unknown,
  requestId: string,
  now = new Date(),
): Promise<ApprovalResult> {
  const id = identifier.safeParse(orderId);
  if (!id.success) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  const parsed = parseRequest(approvalInputSchema, input);
  const decidedAt = now.toISOString();
  const outcome = await withImmediateTransaction(database, async (tx) => {
    const buyerOrganizationId = await buyerOrganization(
      tx,
      actor,
      "approvals:decide",
    );
    const order = await readOrder(tx, buyerOrganizationId, id.data);
    if (order.requesterSubject === actor.subject) {
      throw new ApiError(
        403,
        "SELF_APPROVAL_FORBIDDEN",
        "The requester cannot approve its own order",
      );
    }
    if (order.status !== "awaiting_approval") {
      const prior = await replay(
        tx,
        actor,
        order,
        parsed,
        requestId,
        decidedAt,
      );
      if (prior) return prior;
      throw new ApiError(
        409,
        "APPROVAL_ALREADY_DECIDED",
        "The approval is no longer pending",
      );
    }
    if (order.approvalExpiresAt <= decidedAt) {
      await transitionWithoutDecision(
        tx,
        actor,
        order,
        "expired",
        requestId,
        decidedAt,
      );
      return Object.freeze({ error: "APPROVAL_EXPIRED" as const });
    }
    if (
      parsed.decision === "approve"
      && (
        !await mandateStillApplies(tx, order, decidedAt)
        || !await offerStillApplies(tx, order, decidedAt)
      )
    ) {
      await transitionWithoutDecision(
        tx,
        actor,
        order,
        "stale",
        requestId,
        decidedAt,
      );
      return Object.freeze({ error: "APPROVAL_STALE" as const });
    }
    return decide(tx, actor, order, parsed, requestId, decidedAt);
  });
  if ("error" in outcome) {
    throw new ApiError(
      409,
      outcome.error,
      outcome.error === "APPROVAL_EXPIRED"
        ? "The approval has expired"
        : "The order or mandate changed before approval",
    );
  }
  return outcome;
}
