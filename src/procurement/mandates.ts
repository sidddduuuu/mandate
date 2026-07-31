import type { Db } from "../db";
import { withImmediateTransaction } from "../db";
import { writeAudit } from "../audit/audit";
import type { ActorContext } from "../auth/context";
import { AppError } from "../lib/http";
import { sha256Hex, stableStringify } from "../lib/hash";
import { newId, nowIso } from "../lib/ids";
import {
  mandatePolicySchema,
  policySchemaVersion,
  type MandatePolicy,
} from "./policy";

export type MandateRow = {
  id: string;
  buyer_org_id: string;
  version: number;
  status: "active" | "superseded" | "revoked";
  valid_from: string;
  valid_until: string;
  currency: string;
  autonomous_order_limit_minor: number;
  hard_exception_limit_minor: number;
  budget_window_start: string;
  budget_window_end: string;
  budget_limit_minor: number;
  allowed_supplier_org_ids_json: string;
  allowed_categories_json: string;
  allowed_delivery_location_ids_json: string;
  policy_schema_version: number;
  policy_hash: string;
  created_by_subject: string;
  created_at: string;
};

export function mandateToPolicy(row: MandateRow): MandatePolicy & {
  status: MandateRow["status"];
  buyerOrgId: string;
} {
  return {
    status: row.status,
    buyerOrgId: row.buyer_org_id,
    currency: row.currency,
    autonomous_order_limit_minor: row.autonomous_order_limit_minor,
    hard_exception_limit_minor: row.hard_exception_limit_minor,
    budget_window_start: row.budget_window_start,
    budget_window_end: row.budget_window_end,
    budget_limit_minor: row.budget_limit_minor,
    allowed_supplier_org_ids: JSON.parse(row.allowed_supplier_org_ids_json) as string[],
    allowed_categories: JSON.parse(row.allowed_categories_json) as string[],
    allowed_delivery_location_ids: JSON.parse(
      row.allowed_delivery_location_ids_json,
    ) as string[],
    valid_from: row.valid_from,
    valid_until: row.valid_until,
  };
}

export function getActiveMandate(db: Db, buyerOrgId: string): MandateRow | null {
  return (
    (db
      .prepare(`SELECT * FROM mandates WHERE buyer_org_id = ? AND status = 'active'`)
      .get(buyerOrgId) as MandateRow | undefined) ?? null
  );
}

export function createMandateVersion(
  db: Db,
  actor: ActorContext,
  rawPolicy: unknown,
  requestId: string,
): MandateRow {
  if (actor.actorType !== "human") {
    throw new AppError(403, "forbidden", "Only humans may create mandates");
  }

  const parsed = mandatePolicySchema.safeParse(rawPolicy);
  if (!parsed.success) {
    throw new AppError(400, "invalid_policy", "Mandate policy failed validation");
  }
  const policy = parsed.data;
  const now = nowIso();

  // MVP decision (#3): reject future-dated activation; mandate must be valid now.
  if (Date.parse(policy.valid_from) > Date.parse(now)) {
    throw new AppError(
      400,
      "future_mandate_not_supported",
      "Future-dated mandate activation is not supported in the MVP",
    );
  }
  if (Date.parse(policy.valid_until) <= Date.parse(now)) {
    throw new AppError(400, "invalid_policy", "Mandate valid_until must be in the future");
  }

  const policyHash = sha256Hex(stableStringify({ ...policy, schema: policySchemaVersion }));

  return withImmediateTransaction(db, () => {
    const current = getActiveMandate(db, actor.organizationId);
    const nextVersion = current ? current.version + 1 : 1;
    if (current) {
      db.prepare(`UPDATE mandates SET status = 'superseded' WHERE id = ? AND status = 'active'`).run(
        current.id,
      );
    }

    const id = newId("man");
    db.prepare(
      `INSERT INTO mandates (
        id, buyer_org_id, version, status, valid_from, valid_until, currency,
        autonomous_order_limit_minor, hard_exception_limit_minor,
        budget_window_start, budget_window_end, budget_limit_minor,
        allowed_supplier_org_ids_json, allowed_categories_json,
        allowed_delivery_location_ids_json, policy_schema_version, policy_hash,
        created_by_subject, created_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      actor.organizationId,
      nextVersion,
      policy.valid_from,
      policy.valid_until,
      policy.currency,
      policy.autonomous_order_limit_minor,
      policy.hard_exception_limit_minor,
      policy.budget_window_start,
      policy.budget_window_end,
      policy.budget_limit_minor,
      JSON.stringify(policy.allowed_supplier_org_ids),
      JSON.stringify(policy.allowed_categories),
      JSON.stringify(policy.allowed_delivery_location_ids),
      policySchemaVersion,
      policyHash,
      actor.subject,
      now,
    );

    // Stale awaiting approvals bound to superseded mandate.
    if (current) {
      db.prepare(
        `UPDATE orders
         SET status = 'stale', updated_at = ?
         WHERE buyer_org_id = ?
           AND status = 'awaiting_approval'
           AND mandate_id = ?`,
      ).run(now, actor.organizationId, current.id);
    }

    const row = db.prepare(`SELECT * FROM mandates WHERE id = ?`).get(id) as MandateRow;
    writeAudit(db, {
      aggregateType: "mandate",
      aggregateId: id,
      organizationId: actor.organizationId,
      eventType: "mandate.created",
      actorType: "human",
      actorSubject: actor.subject,
      requestId,
      payload: {
        version: nextVersion,
        policy_hash: policyHash,
        superseded_mandate_id: current?.id ?? null,
      },
    });
    return row;
  });
}

/** MVP decision (#6): emergency revoke supported for humans with mandates:write. */
export function revokeActiveMandate(
  db: Db,
  actor: ActorContext,
  requestId: string,
): MandateRow {
  const now = nowIso();
  return withImmediateTransaction(db, () => {
    const current = getActiveMandate(db, actor.organizationId);
    if (!current) throw new AppError(404, "not_found", "No active mandate");

    db.prepare(`UPDATE mandates SET status = 'revoked' WHERE id = ?`).run(current.id);
    db.prepare(
      `UPDATE orders
       SET status = 'stale', updated_at = ?
       WHERE buyer_org_id = ? AND status = 'awaiting_approval' AND mandate_id = ?`,
    ).run(now, actor.organizationId, current.id);

    writeAudit(db, {
      aggregateType: "mandate",
      aggregateId: current.id,
      organizationId: actor.organizationId,
      eventType: "mandate.revoked",
      actorType: "human",
      actorSubject: actor.subject,
      requestId,
      payload: { version: current.version },
    });

    return db.prepare(`SELECT * FROM mandates WHERE id = ?`).get(current.id) as MandateRow;
  });
}

export function serializeMandate(row: MandateRow) {
  return {
    id: row.id,
    buyer_org_id: row.buyer_org_id,
    version: row.version,
    status: row.status,
    policy_hash: row.policy_hash,
    policy_schema_version: row.policy_schema_version,
    policy: mandateToPolicy(row),
    created_by_subject: row.created_by_subject,
    created_at: row.created_at,
  };
}
