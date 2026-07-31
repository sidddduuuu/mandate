import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  POLICY_CAPS,
  evaluatePolicy,
  type PolicyInput,
} from "../src/procurement/policy.ts";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    buyerOrgId: "buyer-1",
    quantity: 10,
    deliveryLocationId: "kitchen-1",
    remainingBudgetMinor: 50_000,
    offer: {
      supplierOrgId: "supplier-1",
      category: "produce",
      currency: "usd",
      unitPriceMinor: 1_000,
      active: true,
      unexpired: true,
    },
    mandate: {
      buyerOrgId: "buyer-1",
      active: true,
      currency: "usd",
      autonomousOrderLimitMinor: 20_000,
      hardExceptionLimitMinor: 100_000,
      allowedSupplierOrgIds: ["supplier-1"],
      allowedCategories: ["produce"],
      allowedDeliveryLocationIds: ["kitchen-1"],
    },
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("allows an eligible order within autonomous and budget limits", () => {
    assert.deepEqual(evaluatePolicy(input()), {
      decision: "allow",
      reasonCodes: [],
      orderTotalMinor: 10_000,
    });
  });

  it("returns stable order and period-budget approval reasons", () => {
    const base = input();
    const overOrder = evaluatePolicy(
      input({ offer: { ...base.offer, unitPriceMinor: 2_500 } }),
    );
    const overBudget = evaluatePolicy(input({ remainingBudgetMinor: 9_999 }));
    const both = evaluatePolicy(
      input({
        offer: { ...base.offer, unitPriceMinor: 2_500 },
        remainingBudgetMinor: 20_000,
      }),
    );

    assert.deepEqual(overOrder.reasonCodes, ["ORDER_LIMIT_EXCEEDED"]);
    assert.deepEqual(overBudget.reasonCodes, ["PERIOD_BUDGET_EXCEEDED"]);
    assert.deepEqual(
      evaluatePolicy(input({ remainingBudgetMinor: -1 })).reasonCodes,
      ["PERIOD_BUDGET_EXCEEDED"],
    );
    assert.deepEqual(both, {
      decision: "require_approval",
      reasonCodes: [
        "ORDER_LIMIT_EXCEEDED",
        "PERIOD_BUDGET_EXCEEDED",
      ],
      orderTotalMinor: 25_000,
    });
  });

  it("denies hard policy violations instead of making them approvable", () => {
    const base = input();
    const supplierDenied = evaluatePolicy(
      input({
        offer: { ...base.offer, supplierOrgId: "supplier-2" },
      }),
    );
    const hardLimitDenied = evaluatePolicy(
      input({
        offer: { ...base.offer, unitPriceMinor: 10_001 },
      }),
    );

    assert.deepEqual(supplierDenied.reasonCodes, ["SUPPLIER_NOT_ALLOWED"]);
    assert.equal(supplierDenied.decision, "deny");
    assert.deepEqual(hardLimitDenied.reasonCodes, [
      "HARD_EXCEPTION_LIMIT_EXCEEDED",
    ]);
    assert.equal(hardLimitDenied.decision, "deny");
  });

  it("rejects unsafe and capped quantity or price values", () => {
    const base = input();
    assert.deepEqual(
      evaluatePolicy(
        input({ quantity: Number.MAX_SAFE_INTEGER + 1 }),
      ).reasonCodes,
      ["INVALID_QUANTITY"],
    );
    assert.deepEqual(
      evaluatePolicy(
        input({ offer: { ...base.offer, unitPriceMinor: 1.5 } }),
      ).reasonCodes,
      ["INVALID_UNIT_PRICE"],
    );
    assert.deepEqual(
      evaluatePolicy(input({ quantity: POLICY_CAPS.quantity + 1 }))
        .reasonCodes,
      ["QUANTITY_LIMIT_EXCEEDED"],
    );
    assert.deepEqual(
      evaluatePolicy(
        input({
          offer: {
            ...base.offer,
            unitPriceMinor: POLICY_CAPS.unitPriceMinor + 1,
          },
        }),
      ).reasonCodes,
      ["UNIT_PRICE_LIMIT_EXCEEDED"],
    );
  });

  it("rejects multiplication overflow and totals above the fixed cap", () => {
    const base = input();
    const overflow = evaluatePolicy(
      input({
        quantity: POLICY_CAPS.quantity,
        offer: {
          ...base.offer,
          unitPriceMinor: POLICY_CAPS.unitPriceMinor,
        },
      }),
    );
    const capped = evaluatePolicy(
      input({
        quantity: 2,
        offer: {
          ...base.offer,
          unitPriceMinor: POLICY_CAPS.orderTotalMinor,
        },
      }),
    );

    assert.equal(overflow.orderTotalMinor, null);
    assert.deepEqual(overflow.reasonCodes, ["ORDER_TOTAL_OVERFLOW"]);
    assert.equal(capped.orderTotalMinor, null);
    assert.deepEqual(capped.reasonCodes, [
      "ORDER_TOTAL_LIMIT_EXCEEDED",
    ]);
  });
});
