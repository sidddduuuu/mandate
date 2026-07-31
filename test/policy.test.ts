import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, type PolicyEvaluationInput } from "../src/procurement/policy";
import { computeOrderTotalMinor, MoneyError } from "../src/lib/money";

function baseInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 86400000).toISOString();
  const from = new Date(Date.now() - 86400000).toISOString();
  return {
    nowIso: now,
    buyerOrgId: "buyer",
    actorBuyerOrgId: "buyer",
    quantity: 1,
    totalMinor: 1000,
    deliveryLocationId: "kitchen-1",
    offer: {
      supplierOrgId: "sup-a",
      category: "produce",
      currency: "USD",
      active: true,
      expired: false,
      unitPriceMinor: 1000,
    },
    mandate: {
      status: "active",
      buyerOrgId: "buyer",
      currency: "USD",
      autonomous_order_limit_minor: 5000,
      hard_exception_limit_minor: 20_000,
      budget_window_start: from,
      budget_window_end: until,
      budget_limit_minor: 50_000,
      allowed_supplier_org_ids: ["sup-a"],
      allowed_categories: ["produce"],
      allowed_delivery_location_ids: ["kitchen-1"],
      valid_from: from,
      valid_until: until,
    },
    committedSpendMinor: 0,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("allows autonomous purchases under limits", () => {
    const result = evaluatePolicy(baseInput());
    assert.equal(result.decision, "allow");
  });

  it("requires approval above autonomous order limit", () => {
    const result = evaluatePolicy(baseInput({ totalMinor: 6000 }));
    assert.equal(result.decision, "require_approval");
    assert.ok(result.reasons.includes("above_autonomous_order_limit"));
  });

  it("requires approval when period budget is insufficient", () => {
    const result = evaluatePolicy(
      baseInput({ totalMinor: 4000, committedSpendMinor: 48_000 }),
    );
    assert.equal(result.decision, "require_approval");
    assert.ok(result.reasons.includes("above_period_budget"));
  });

  it("denies above hard exception limit", () => {
    const result = evaluatePolicy(baseInput({ totalMinor: 25_000 }));
    assert.equal(result.decision, "deny");
    assert.deepEqual(result.reasons, ["above_hard_exception_limit"]);
  });

  it("denies disallowed supplier/category/delivery/currency", () => {
    assert.equal(
      evaluatePolicy(
        baseInput({ offer: { ...baseInput().offer, supplierOrgId: "other" } }),
      ).decision,
      "deny",
    );
    assert.equal(
      evaluatePolicy(
        baseInput({ offer: { ...baseInput().offer, category: "dairy" } }),
      ).decision,
      "deny",
    );
    assert.equal(
      evaluatePolicy(baseInput({ deliveryLocationId: "wrong" })).decision,
      "deny",
    );
    assert.equal(
      evaluatePolicy(
        baseInput({ offer: { ...baseInput().offer, currency: "EUR" } }),
      ).decision,
      "deny",
    );
  });

  it("denies missing/inactive mandate and bad quantity", () => {
    assert.equal(evaluatePolicy(baseInput({ mandate: null })).decision, "deny");
    assert.equal(
      evaluatePolicy(
        baseInput({
          mandate: { ...baseInput().mandate!, status: "revoked" },
        }),
      ).decision,
      "deny",
    );
    assert.equal(evaluatePolicy(baseInput({ quantity: 0 })).decision, "deny");
  });
});

describe("computeOrderTotalMinor", () => {
  const caps = { maxUnitPrice: 10_000, maxQuantity: 100, maxOrderTotal: 100_000 };

  it("computes totals and rejects overflow/caps", () => {
    assert.equal(computeOrderTotalMinor(3900, 2, caps), 7800);
    assert.throws(() => computeOrderTotalMinor(20_000, 1, caps), MoneyError);
    assert.throws(() => computeOrderTotalMinor(2000, 1000, caps), MoneyError);
    assert.throws(() => computeOrderTotalMinor(3000, 40, caps), MoneyError);
  });
});
