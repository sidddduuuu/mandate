import { z } from "zod";

export const policySchemaVersion = 1;

export const mandatePolicySchema = z
  .object({
    currency: z.string().length(3),
    autonomous_order_limit_minor: z.number().int().positive(),
    hard_exception_limit_minor: z.number().int().positive(),
    budget_window_start: z.string().datetime(),
    budget_window_end: z.string().datetime(),
    budget_limit_minor: z.number().int().positive(),
    allowed_supplier_org_ids: z.array(z.string().min(1)).min(1),
    allowed_categories: z.array(z.string().min(1)).min(1),
    allowed_delivery_location_ids: z.array(z.string().min(1)).min(1),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime(),
  })
  .superRefine((v, ctx) => {
    if (v.hard_exception_limit_minor < v.autonomous_order_limit_minor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hard_exception_limit_minor must be >= autonomous_order_limit_minor",
      });
    }
    if (Date.parse(v.budget_window_end) <= Date.parse(v.budget_window_start)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "budget_window_end must be after budget_window_start",
      });
    }
    if (Date.parse(v.valid_until) <= Date.parse(v.valid_from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "valid_until must be after valid_from",
      });
    }
  });

export type MandatePolicy = z.infer<typeof mandatePolicySchema>;

export type PolicyDecision = "allow" | "require_approval" | "deny";

export type PolicyReasonCode =
  | "missing_mandate"
  | "inactive_mandate"
  | "mandate_not_yet_valid"
  | "mandate_expired"
  | "inactive_budget_window"
  | "tenant_mismatch"
  | "malformed_quantity"
  | "stale_offer"
  | "inactive_offer"
  | "currency_mismatch"
  | "supplier_not_allowed"
  | "category_not_allowed"
  | "delivery_not_allowed"
  | "above_hard_exception_limit"
  | "above_autonomous_order_limit"
  | "above_period_budget"
  | "ok";

export type PolicyOfferInput = {
  supplierOrgId: string;
  category: string;
  currency: string;
  active: boolean;
  expired: boolean;
  unitPriceMinor: number;
};

export type PolicyEvaluationInput = {
  nowIso: string;
  buyerOrgId: string;
  actorBuyerOrgId: string;
  quantity: number;
  totalMinor: number;
  deliveryLocationId: string;
  offer: PolicyOfferInput;
  mandate: (MandatePolicy & { status: "active" | "superseded" | "revoked"; buyerOrgId: string }) | null;
  committedSpendMinor: number;
};

export type PolicyEvaluationResult = {
  decision: PolicyDecision;
  reasons: PolicyReasonCode[];
};

/** Pure policy evaluator: no I/O. */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const reasons: PolicyReasonCode[] = [];
  const now = Date.parse(input.nowIso);

  if (input.buyerOrgId !== input.actorBuyerOrgId) {
    return { decision: "deny", reasons: ["tenant_mismatch"] };
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    return { decision: "deny", reasons: ["malformed_quantity"] };
  }
  if (!input.mandate) {
    return { decision: "deny", reasons: ["missing_mandate"] };
  }
  if (input.mandate.status !== "active") {
    return { decision: "deny", reasons: ["inactive_mandate"] };
  }
  if (input.mandate.buyerOrgId !== input.buyerOrgId) {
    return { decision: "deny", reasons: ["tenant_mismatch"] };
  }
  if (now < Date.parse(input.mandate.valid_from)) {
    return { decision: "deny", reasons: ["mandate_not_yet_valid"] };
  }
  if (now >= Date.parse(input.mandate.valid_until)) {
    return { decision: "deny", reasons: ["mandate_expired"] };
  }
  if (
    now < Date.parse(input.mandate.budget_window_start) ||
    now >= Date.parse(input.mandate.budget_window_end)
  ) {
    return { decision: "deny", reasons: ["inactive_budget_window"] };
  }
  if (!input.offer.active) {
    return { decision: "deny", reasons: ["inactive_offer"] };
  }
  if (input.offer.expired) {
    return { decision: "deny", reasons: ["stale_offer"] };
  }
  if (input.offer.currency !== input.mandate.currency) {
    return { decision: "deny", reasons: ["currency_mismatch"] };
  }
  if (!input.mandate.allowed_supplier_org_ids.includes(input.offer.supplierOrgId)) {
    return { decision: "deny", reasons: ["supplier_not_allowed"] };
  }
  if (!input.mandate.allowed_categories.includes(input.offer.category)) {
    return { decision: "deny", reasons: ["category_not_allowed"] };
  }
  if (!input.mandate.allowed_delivery_location_ids.includes(input.deliveryLocationId)) {
    return { decision: "deny", reasons: ["delivery_not_allowed"] };
  }
  if (input.totalMinor > input.mandate.hard_exception_limit_minor) {
    return { decision: "deny", reasons: ["above_hard_exception_limit"] };
  }

  const remainingBudget = input.mandate.budget_limit_minor - input.committedSpendMinor;
  const needsApprovalForBudget = input.totalMinor > remainingBudget;
  const needsApprovalForOrder =
    input.totalMinor > input.mandate.autonomous_order_limit_minor;

  if (needsApprovalForOrder) reasons.push("above_autonomous_order_limit");
  if (needsApprovalForBudget) reasons.push("above_period_budget");

  if (needsApprovalForOrder || needsApprovalForBudget) {
    return { decision: "require_approval", reasons };
  }

  return { decision: "allow", reasons: ["ok"] };
}
