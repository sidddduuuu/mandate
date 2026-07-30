export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertSafePositiveInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyError(`${label} must be a positive safe integer`);
  }
}

export function assertSafeNonNegativeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${label} must be a non-negative safe integer`);
  }
}

/** Multiply unit price by quantity with overflow and cap checks before multiplying. */
export function computeOrderTotalMinor(
  unitPriceMinor: number,
  quantity: number,
  caps: { maxUnitPrice: number; maxQuantity: number; maxOrderTotal: number },
): number {
  assertSafePositiveInt(unitPriceMinor, "unit_price");
  assertSafePositiveInt(quantity, "quantity");

  if (unitPriceMinor > caps.maxUnitPrice) {
    throw new MoneyError("unit_price exceeds maximum");
  }
  if (quantity > caps.maxQuantity) {
    throw new MoneyError("quantity exceeds maximum");
  }
  if (unitPriceMinor > Math.floor(caps.maxOrderTotal / quantity)) {
    throw new MoneyError("order total would exceed maximum");
  }

  const total = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(total) || total > caps.maxOrderTotal) {
    throw new MoneyError("order total exceeds maximum");
  }
  return total;
}
