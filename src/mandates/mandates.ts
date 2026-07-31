import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audit, now } from "@/db";

type MandateInput = {
  valid_from: string;
  valid_until: string;
  currency: string;
  autonomous_limit_minor: number;
  hard_limit_minor: number;
  budget_window: {
    starts_at: string;
    ends_at: string;
    limit_minor: number;
  };
  allowed_supplier_ids: string[];
  allowed_categories: string[];
  delivery_location_ids: string[];
};

export class MandateError extends Error {
  constructor(readonly code: string, readonly status = 422) {
    super(code);
  }
}

const fields = new Set([
  "valid_from",
  "valid_until",
  "currency",
  "autonomous_limit_minor",
  "hard_limit_minor",
  "budget_window",
  "allowed_supplier_ids",
  "allowed_categories",
  "delivery_location_ids",
]);

function utc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function money(value: unknown, allowZero = false): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= (allowZero ? 0 : 1) &&
    (value as number) <= 1_000_000_000
  );
}

function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(item),
    ) &&
    new Set(value).size === value.length
  );
}

export function parseMandate(value: unknown): MandateInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.has(key))
  ) {
    throw new MandateError("invalid_mandate");
  }
  const input = value as Record<string, unknown>;
  if (!utc(input.valid_from) || !utc(input.valid_until)) {
    throw new MandateError("invalid_validity");
  }
  const current = Date.parse(now());
  if (Date.parse(input.valid_from) > current) {
    throw new MandateError("future_activation_unsupported");
  }
  if (Date.parse(input.valid_until) <= current) {
    throw new MandateError("invalid_validity");
  }
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new MandateError("invalid_currency");
  }
  if (
    !money(input.autonomous_limit_minor, true) ||
    !money(input.hard_limit_minor) ||
    input.autonomous_limit_minor > input.hard_limit_minor
  ) {
    throw new MandateError("invalid_order_limits");
  }
  const window = input.budget_window;
  if (!window || typeof window !== "object" || Array.isArray(window)) {
    throw new MandateError("invalid_budget_window");
  }
  const budget = window as Record<string, unknown>;
  if (
    Object.keys(budget).some(
      (key) => !["starts_at", "ends_at", "limit_minor"].includes(key),
    ) ||
    !utc(budget.starts_at) ||
    !utc(budget.ends_at) ||
    !money(budget.limit_minor) ||
    Date.parse(budget.starts_at) > current ||
    Date.parse(budget.ends_at) <= current
  ) {
    throw new MandateError("invalid_budget_window");
  }
  if (
    !ids(input.allowed_supplier_ids) ||
    !ids(input.allowed_categories) ||
    !ids(input.delivery_location_ids)
  ) {
    throw new MandateError("invalid_policy_scope");
  }
  return {
    ...(input as Omit<MandateInput, "budget_window">),
    budget_window: budget as MandateInput["budget_window"],
  };
}

export function createMandate(input: {
  db: DatabaseSync;
  organizationId: string;
  creatorSubject: string;
  requestId: string;
  mandate: MandateInput;
}) {
  const { db, organizationId, creatorSubject, requestId } = input;
  const mandate = {
    ...input.mandate,
    allowed_supplier_ids: [...input.mandate.allowed_supplier_ids].sort(),
    allowed_categories: [...input.mandate.allowed_categories].sort(),
    delivery_location_ids: [...input.mandate.delivery_location_ids].sort(),
  };
  const suppliers = db
    .prepare(`
      SELECT id FROM organizations
      WHERE kind = 'supplier' AND id IN (SELECT value FROM json_each(?))
    `)
    .all(JSON.stringify(mandate.allowed_supplier_ids)) as { id: string }[];
  if (suppliers.length !== mandate.allowed_supplier_ids.length) {
    throw new MandateError("unknown_supplier");
  }

  const policyHash = createHash("sha256")
    .update(JSON.stringify({ schema_version: 1, ...mandate }))
    .digest("hex");
  const id = randomUUID();
  let version = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const overlap = db
      .prepare(`
        SELECT 1 FROM budget_windows
        WHERE buyer_organization_id = ?
          AND NOT (ends_at <= ? OR starts_at >= ?)
          AND NOT (currency = ? AND starts_at = ? AND ends_at = ?)
        LIMIT 1
      `)
      .get(
        organizationId,
        mandate.budget_window.starts_at,
        mandate.budget_window.ends_at,
        mandate.currency,
        mandate.budget_window.starts_at,
        mandate.budget_window.ends_at,
      );
    if (overlap) throw new MandateError("overlapping_budget_window", 409);

    db.prepare(`
      INSERT OR IGNORE INTO budget_windows
        (buyer_organization_id, currency, starts_at, ends_at)
      VALUES (?, ?, ?, ?)
    `).run(
      organizationId,
      mandate.currency,
      mandate.budget_window.starts_at,
      mandate.budget_window.ends_at,
    );
    version = Number(
      (
        db
          .prepare(`
            SELECT COALESCE(MAX(version), 0) + 1 AS version
            FROM mandates WHERE buyer_organization_id = ?
          `)
          .get(organizationId) as { version: number }
      ).version,
    );
    db.prepare(`
      UPDATE mandates SET state = 'superseded'
      WHERE buyer_organization_id = ? AND state = 'active'
    `).run(organizationId);
    db.prepare(`
      INSERT INTO mandates (
        id, buyer_organization_id, version, state, valid_from, valid_until,
        currency, autonomous_limit_minor, hard_limit_minor, budget_starts_at,
        budget_ends_at, budget_limit_minor, allowed_supplier_ids_json,
        allowed_categories_json, delivery_location_ids_json, schema_version,
        policy_hash, creator_subject, created_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      organizationId,
      version,
      mandate.valid_from,
      mandate.valid_until,
      mandate.currency,
      mandate.autonomous_limit_minor,
      mandate.hard_limit_minor,
      mandate.budget_window.starts_at,
      mandate.budget_window.ends_at,
      mandate.budget_window.limit_minor,
      JSON.stringify(mandate.allowed_supplier_ids),
      JSON.stringify(mandate.allowed_categories),
      JSON.stringify(mandate.delivery_location_ids),
      policyHash,
      creatorSubject,
      now(),
    );
    audit({
      organizationId,
      eventType: "mandate.created",
      actorType: "human",
      actorSubject: creatorSubject,
      requestId,
      payload: { mandate_id: id, version, policy_hash: policyHash },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    id,
    version,
    state: "active",
    policy_hash: policyHash,
    ...mandate,
  };
}
