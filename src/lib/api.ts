import { getDb } from "../db";
import {
  authenticateRequest,
  requireAgentScope,
  requireCsrf,
  requireHumanPermission,
  type ActorContext,
} from "../auth/context";
import { createStripeAdapter, type StripeAdapter } from "../payments/stripe";
import { checkRateLimit } from "./rate-limit";
import { AppError, getRequestId, jsonError, toErrorResponse } from "./http";

let stripeOverride: StripeAdapter | null = null;

export function setStripeOverride(adapter: StripeAdapter | null): void {
  stripeOverride = adapter;
}

export function getStripe(): StripeAdapter {
  return stripeOverride ?? createStripeAdapter();
}

export async function withApi(
  request: Request,
  handler: (ctx: {
    requestId: string;
    actor: ActorContext;
    db: ReturnType<typeof getDb>;
  }) => Promise<Response>,
  options?: {
    agentScope?: string;
    humanPermission?: string;
    csrf?: boolean;
    rateLimit?: { limit: number; windowMs: number };
  },
): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const db = getDb();
    const actor = await authenticateRequest(db, request, requestId);

    if (options?.agentScope) requireAgentScope(actor, options.agentScope);
    if (options?.humanPermission) requireHumanPermission(actor, options.humanPermission);
    if (options?.csrf) requireCsrf(request);

    if (options?.rateLimit) {
      const key = `${actor.subject}:${request.method}:${new URL(request.url).pathname}`;
      const result = checkRateLimit(key, options.rateLimit.limit, options.rateLimit.windowMs);
      if (!result.allowed) {
        return jsonError(429, "rate_limited", "Rate limit exceeded", requestId);
      }
    }

    return await handler({ requestId, actor, db });
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 64_000) {
    throw new AppError(413, "payload_too_large", "Request body too large");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be JSON");
  }
}
