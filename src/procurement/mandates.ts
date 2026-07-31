import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { AuthError, type ActorContext } from "../auth/context.ts";
import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError, parseRequest } from "../http.ts";
import { releaseOfferReservation } from "./reservations.ts";
import { POLICY_CAPS } from "./policy.ts";

const identifier = z.string().trim().min(1).max(128);
const utcTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
).refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const identifiers = z.array(identifier).max(100)
  .refine((values) => new Set(values).size === values.length)
  .transform((values) => [...values].sort());

export const mandatePolicySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  autonomousOrderLimitMinor: z.number().int().nonnegative()
    .max(POLICY_CAPS.orderTotalMinor),
  hardExceptionLimitMinor: z.number().int().nonnegative()
    .max(POLICY_CAPS.orderTotalMinor),
  budgetWindow: z.object({
    start: utcTimestamp,
    end: utcTimestamp,
    limitMinor: z.number().int().nonnegative()
      .max(POLICY_CAPS.periodBudgetMinor),
  }).strict().refine((window) => window.end > window.start),
  allowedSupplierOrgIds: identifiers,
  allowedCategories: identifiers,
  allowedDeliveryLocationIds: identifiers,
}).strict().refine(
  (policy) =>
    policy.autonomousOrderLimitMinor <= policy.hardExceptionLimitMinor,
  { message: "Autonomous limit cannot exceed hard exception limit" },
);

export type MandatePolicyData = z.output<typeof mandatePolicySchema>;

const createMandateSchema = z.object({
  validFrom: utcTimestamp,
  validUntil: utcTimestamp,
  policy: mandatePolicySchema,
}).strict().superRefine((value, context) => {
  if (value.validUntil <= value.validFrom) {
    context.addIssue({ code: "custom", message: "Mandate validity is invalid" });
  }
  if (
    value.policy.budgetWindow.start < value.validFrom
    || value.policy.budgetWindow.end > value.validUntil
  ) {
    context.addIssue({ code: "custom", message: "Budget window exceeds mandate validity" });
  }
});

export type CreatedMandate = Readonly<{
  id: string;
  buyerOrganizationId: string;
  version: number;
  policyHash: string;
  validFrom: string;
  validUntil: string;
}>;

async function requireBuyer(
  database: Database,
  actor: ActorContext,
): Promise<string> {
  if (
    actor.actorType !== "human"
    || !actor.scopes.includes("mandates:write")
  ) {
    throw new AuthError("forbidden");
  }
  const lockClause = "prepare" in database ? "" : " FOR UPDATE";
  const organization = await database.get(
    `SELECT id, kind FROM organizations WHERE auth0_org_id = ?${lockClause}`,
    actor.organizationId,
  );
  if (typeof organization?.id !== "string" || organization.kind !== "buyer") {
    throw new AuthError("forbidden");
  }
  return organization.id;
}

function canonicalPolicy(policy: MandatePolicyData): string {
  return JSON.stringify({
    allowedCategories: policy.allowedCategories,
    allowedDeliveryLocationIds: policy.allowedDeliveryLocationIds,
    allowedSupplierOrgIds: policy.allowedSupplierOrgIds,
    autonomousOrderLimitMinor: policy.autonomousOrderLimitMinor,
    budgetWindow: {
      end: policy.budgetWindow.end,
      limitMinor: policy.budgetWindow.limitMinor,
      start: policy.budgetWindow.start,
    },
    currency: policy.currency,
    hardExceptionLimitMinor: policy.hardExceptionLimitMinor,
  });
}

export async function createMandate(
  database: Database,
  actor: ActorContext,
  input: unknown,
  requestId: string,
  now = new Date(),
): Promise<CreatedMandate> {
  const parsed = parseRequest(createMandateSchema, input);
  const policyJson = canonicalPolicy(parsed.policy);
  const policyHash = createHash("sha256").update(policyJson).digest("hex");
  const id = randomUUID();
  const createdAt = now.toISOString();

  return withImmediateTransaction(database, async (transaction) => {
    const buyerOrganizationId = await requireBuyer(transaction, actor);
    if (parsed.policy.allowedSupplierOrgIds.length) {
      const placeholders = parsed.policy.allowedSupplierOrgIds
        .map(() => "?")
        .join(",");
      const registered = await transaction.get(
        `SELECT count(*) AS count FROM organizations
         WHERE kind = 'supplier' AND id IN (${placeholders})`,
        ...parsed.policy.allowedSupplierOrgIds,
      );
      if (
        Number(registered?.count) !==
        parsed.policy.allowedSupplierOrgIds.length
      ) {
        throw new ApiError(
          400,
          "UNKNOWN_SUPPLIER",
          "Mandate contains an unknown supplier",
        );
      }
    }
    const latest = await transaction.get(
      "SELECT COALESCE(MAX(version), 0) AS version FROM mandates WHERE buyer_organization_id = ?",
      buyerOrganizationId,
    );
    const version = Number(latest?.version) + 1;
    const staleOrders = await transaction.all(`
      UPDATE orders
      SET status = 'stale', updated_at = ?
      WHERE buyer_organization_id = ? AND status = 'awaiting_approval'
      RETURNING id
    `, createdAt, buyerOrganizationId);
    for (const order of staleOrders) {
      await releaseOfferReservation(transaction, String(order.id), createdAt);
      await transaction.run(`
        INSERT INTO audit_events (
          aggregate_type, aggregate_id, organization_id, event_type, actor_type,
          actor_subject, request_id, payload_json, created_at
        ) VALUES ('order', ?, ?, 'order.stale', ?, ?, ?, ?, ?)
      `,
        order.id,
        buyerOrganizationId,
        actor.actorType,
        actor.subject,
        requestId,
        JSON.stringify({
          reason: "MANDATE_SUPERSEDED",
          supersededByMandateId: id,
          supersededByVersion: version,
        }),
        createdAt,
      );
    }
    await transaction.run(
      "UPDATE mandates SET state = 'superseded' WHERE buyer_organization_id = ? AND state = 'active'",
      buyerOrganizationId,
    );
    await transaction.run(`
      INSERT INTO mandates (
        id, buyer_organization_id, version, state, valid_from, valid_until,
        policy_json, schema_version, policy_hash, created_by_subject, created_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, 1, ?, ?, ?)
    `,
      id, buyerOrganizationId, version, parsed.validFrom, parsed.validUntil,
      policyJson, policyHash, actor.subject, createdAt,
    );
    await transaction.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('mandate', ?, ?, 'mandate.created', ?, ?, ?, ?, ?)
    `,
      id, buyerOrganizationId, actor.actorType, actor.subject, requestId,
      JSON.stringify({ policyHash, version }), createdAt,
    );
    return Object.freeze({
      id,
      buyerOrganizationId,
      version,
      policyHash,
      validFrom: parsed.validFrom,
      validUntil: parsed.validUntil,
    });
  });
}
