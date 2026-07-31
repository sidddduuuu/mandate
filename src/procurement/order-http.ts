import { z } from "zod";

import { ApiError, ok } from "../http.ts";
import type { CreateOrderResult } from "./orders.ts";

export function requireIdempotencyKey(value: string | null): string {
  if (!value || !z.string().uuid().safeParse(value).success) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a UUID",
    );
  }
  return value;
}

export function orderResponse(result: CreateOrderResult) {
  const status = result.replayed
    ? 200
    : result.kind === "denial"
      ? 422
      : result.order.policyDecision === "require_approval"
        ? 202
        : 201;
  const response = ok(
    result.kind === "order" ? result.order : result.denial,
    status,
  );
  response.headers.set("cache-control", "private, no-store");
  if (result.replayed)
    response.headers.set("idempotent-replayed", "true");
  if (result.kind === "order")
    response.headers.set("location", `/api/orders/${result.order.id}`);
  return response;
}
