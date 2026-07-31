import assert from "node:assert/strict";
import test from "node:test";

import {
  orderResponse,
  requireIdempotencyKey,
} from "../src/procurement/order-http.ts";
import { ApiError } from "../src/http.ts";
import type {
  BuyerOrder,
  CreateOrderResult,
} from "../src/procurement/orders.ts";

const baseOrder: BuyerOrder = Object.freeze({
  view: "buyer",
  id: "00000000-0000-4000-8000-000000000101",
  buyerOrganizationId: "buyer",
  supplierOrganizationId: "supplier",
  requesterSubject: "buyer-agent",
  mandateId: "mandate",
  mandateVersion: 1,
  mandateHash: "a".repeat(64),
  catalogItemId: "offer",
  catalogItemVersion: 1,
  sku: "avocado",
  productKey: "hass-avocado",
  category: "produce",
  unit: "case",
  unitPriceMinor: 1_000,
  quantity: 10,
  currency: "USD",
  totalMinor: 10_000,
  deliveryLocationId: "kitchen",
  status: "payment_pending",
  policyDecision: "allow",
  policyReasonCodes: Object.freeze([]),
  approvalExpiresAt: null,
  approvalActorSubject: null,
  approvalDecidedAt: null,
  approvalReason: null,
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
});

function orderResult(
  policyDecision: BuyerOrder["policyDecision"],
  status: BuyerOrder["status"],
  replayed = false,
): CreateOrderResult {
  return Object.freeze({
    kind: "order",
    replayed,
    order: Object.freeze({ ...baseOrder, policyDecision, status }),
  });
}

test("order responses map domain outcomes to stable statuses and headers", () => {
  const allowed = orderResponse(orderResult("allow", "payment_pending"));
  const approval = orderResponse(
    orderResult("require_approval", "awaiting_approval"),
  );
  const hardDenial = orderResponse(orderResult("deny", "denied"));
  const noSnapshot = orderResponse({
    kind: "denial",
    replayed: false,
    denial: {
      status: "denied",
      policyDecision: "deny",
      policyReasonCodes: ["NO_ELIGIBLE_OFFER"],
      idempotencyKey: "00000000-0000-4000-8000-000000000102",
      createdAt: "2026-07-30T12:00:00.000Z",
    },
  });
  const replay = orderResponse(
    orderResult("require_approval", "awaiting_approval", true),
  );

  assert.equal(allowed.status, 201);
  assert.equal(
    allowed.headers.get("location"),
    `/api/orders/${baseOrder.id}`,
  );
  assert.equal(approval.status, 202);
  assert.equal(hardDenial.status, 201);
  assert.equal(noSnapshot.status, 422);
  assert.equal(noSnapshot.headers.get("location"), null);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  for (const response of [
    allowed,
    approval,
    hardDenial,
    noSnapshot,
    replay,
  ]) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("order route requires a UUID idempotency key", () => {
  assert.equal(
    requireIdempotencyKey("00000000-0000-4000-8000-000000000103"),
    "00000000-0000-4000-8000-000000000103",
  );
  for (const value of [null, "", "not-a-uuid", "id-1, id-2"]) {
    assert.throws(
      () => requireIdempotencyKey(value),
      (error: unknown) =>
        error instanceof ApiError
        && error.status === 400
        && error.code === "INVALID_IDEMPOTENCY_KEY",
    );
  }
});
