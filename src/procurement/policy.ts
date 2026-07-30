export const POLICY_CAPS = Object.freeze({
  quantity: 1_000_000,
  unitPriceMinor: 10_000_000_000,
  orderTotalMinor: 10_000_000_000,
  periodBudgetMinor: 1_000_000_000_000,
});

export type PolicyDecision = "allow" | "require_approval" | "deny";

export type PolicyReasonCode =
  | "INVALID_QUANTITY"
  | "QUANTITY_LIMIT_EXCEEDED"
  | "INVALID_UNIT_PRICE"
  | "UNIT_PRICE_LIMIT_EXCEEDED"
  | "ORDER_TOTAL_OVERFLOW"
  | "ORDER_TOTAL_LIMIT_EXCEEDED"
  | "MANDATE_MISSING"
  | "MANDATE_INACTIVE"
  | "MANDATE_INVALID"
  | "TENANT_MISMATCH"
  | "OFFER_INACTIVE"
  | "OFFER_STALE"
  | "CURRENCY_MISMATCH"
  | "SUPPLIER_NOT_ALLOWED"
  | "CATEGORY_NOT_ALLOWED"
  | "DELIVERY_LOCATION_NOT_ALLOWED"
  | "HARD_EXCEPTION_LIMIT_EXCEEDED"
  | "ORDER_LIMIT_EXCEEDED"
  | "PERIOD_BUDGET_EXCEEDED";

export interface MandatePolicy {
  readonly buyerOrgId: string;
  readonly active: boolean;
  readonly currency: string;
  readonly autonomousOrderLimitMinor: number;
  readonly hardExceptionLimitMinor: number;
  readonly allowedSupplierOrgIds: readonly string[];
  readonly allowedCategories: readonly string[];
  readonly allowedDeliveryLocationIds: readonly string[];
}

export interface PolicyOffer {
  readonly supplierOrgId: string;
  readonly category: string;
  readonly currency: string;
  readonly unitPriceMinor: number;
  readonly active: boolean;
  readonly unexpired: boolean;
}

export interface PolicyInput {
  readonly buyerOrgId: string;
  readonly quantity: number;
  readonly deliveryLocationId: string;
  readonly remainingBudgetMinor: number;
  readonly offer: Readonly<PolicyOffer>;
  readonly mandate: Readonly<MandatePolicy> | null;
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly orderTotalMinor: number | null;
}

function priceOrder(
  quantity: number,
  unitPriceMinor: number,
): Pick<PolicyEvaluation, "orderTotalMinor" | "reasonCodes"> {
  const reasonCodes: PolicyReasonCode[] = [];
  const quantityValid = Number.isSafeInteger(quantity) && quantity > 0;
  const priceValid = Number.isSafeInteger(unitPriceMinor) && unitPriceMinor > 0;

  if (!quantityValid) reasonCodes.push("INVALID_QUANTITY");
  else if (quantity > POLICY_CAPS.quantity)
    reasonCodes.push("QUANTITY_LIMIT_EXCEEDED");
  if (!priceValid) reasonCodes.push("INVALID_UNIT_PRICE");
  else if (unitPriceMinor > POLICY_CAPS.unitPriceMinor)
    reasonCodes.push("UNIT_PRICE_LIMIT_EXCEEDED");
  if (reasonCodes.length) return { orderTotalMinor: null, reasonCodes };

  if (unitPriceMinor > Math.floor(Number.MAX_SAFE_INTEGER / quantity))
    return { orderTotalMinor: null, reasonCodes: ["ORDER_TOTAL_OVERFLOW"] };
  if (unitPriceMinor > Math.floor(POLICY_CAPS.orderTotalMinor / quantity))
    return {
      orderTotalMinor: null,
      reasonCodes: ["ORDER_TOTAL_LIMIT_EXCEEDED"],
    };
  return { orderTotalMinor: unitPriceMinor * quantity, reasonCodes };
}

function validMinorAmount(value: number, cap: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= cap;
}

function mandateIsValid(
  mandate: Readonly<MandatePolicy>,
  remainingBudgetMinor: number,
): boolean {
  return (
    validMinorAmount(
      mandate.autonomousOrderLimitMinor,
      POLICY_CAPS.orderTotalMinor,
    ) &&
    validMinorAmount(
      mandate.hardExceptionLimitMinor,
      POLICY_CAPS.orderTotalMinor,
    ) &&
    mandate.autonomousOrderLimitMinor <= mandate.hardExceptionLimitMinor &&
    validMinorAmount(
      remainingBudgetMinor,
      POLICY_CAPS.periodBudgetMinor,
    )
  );
}

function hardRuleReasons(
  input: Readonly<PolicyInput>,
  orderTotalMinor: number | null,
): PolicyReasonCode[] {
  const mandate = input.mandate;
  if (!mandate) return ["MANDATE_MISSING"];

  const reasonCodes: PolicyReasonCode[] = [];
  const validMandate = mandateIsValid(mandate, input.remainingBudgetMinor);
  if (!mandate.active) reasonCodes.push("MANDATE_INACTIVE");
  if (!validMandate) reasonCodes.push("MANDATE_INVALID");
  if (mandate.buyerOrgId !== input.buyerOrgId)
    reasonCodes.push("TENANT_MISMATCH");
  if (!input.offer.active) reasonCodes.push("OFFER_INACTIVE");
  if (!input.offer.unexpired) reasonCodes.push("OFFER_STALE");
  if (input.offer.currency !== mandate.currency)
    reasonCodes.push("CURRENCY_MISMATCH");
  if (!mandate.allowedSupplierOrgIds.includes(input.offer.supplierOrgId))
    reasonCodes.push("SUPPLIER_NOT_ALLOWED");
  if (!mandate.allowedCategories.includes(input.offer.category))
    reasonCodes.push("CATEGORY_NOT_ALLOWED");
  if (!mandate.allowedDeliveryLocationIds.includes(input.deliveryLocationId))
    reasonCodes.push("DELIVERY_LOCATION_NOT_ALLOWED");
  if (
    validMandate &&
    orderTotalMinor !== null &&
    orderTotalMinor > mandate.hardExceptionLimitMinor
  )
    reasonCodes.push("HARD_EXCEPTION_LIMIT_EXCEEDED");
  return reasonCodes;
}

function result(
  decision: PolicyDecision,
  reasonCodes: readonly PolicyReasonCode[],
  orderTotalMinor: number | null,
): PolicyEvaluation {
  return Object.freeze({
    decision,
    reasonCodes: Object.freeze([...reasonCodes]),
    orderTotalMinor,
  });
}

export function evaluatePolicy(
  input: Readonly<PolicyInput>,
): PolicyEvaluation {
  const priced = priceOrder(input.quantity, input.offer.unitPriceMinor);
  const hardReasons = [
    ...priced.reasonCodes,
    ...hardRuleReasons(input, priced.orderTotalMinor),
  ];
  if (hardReasons.length)
    return result("deny", hardReasons, priced.orderTotalMinor);

  const mandate = input.mandate as Readonly<MandatePolicy>;
  const orderTotalMinor = priced.orderTotalMinor as number;
  const approvalReasons: PolicyReasonCode[] = [];
  if (orderTotalMinor > mandate.autonomousOrderLimitMinor)
    approvalReasons.push("ORDER_LIMIT_EXCEEDED");
  if (orderTotalMinor > input.remainingBudgetMinor)
    approvalReasons.push("PERIOD_BUDGET_EXCEEDED");
  return result(
    approvalReasons.length ? "require_approval" : "allow",
    approvalReasons,
    orderTotalMinor,
  );
}
