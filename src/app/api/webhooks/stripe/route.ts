import { getDb } from "@/db";
import { getStripe } from "@/lib/api";
import { getRequestId, jsonError, jsonOk, toErrorResponse } from "@/lib/http";
import { handleStripeWebhook } from "@/procurement/orders";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.byteLength > 256_000) {
      return jsonError(413, "payload_too_large", "Webhook body too large", requestId);
    }
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return jsonError(400, "invalid_signature", "Missing Stripe signature", requestId);
    }

    const stripe = getStripe();
    let event;
    try {
      event = stripe.constructEvent(raw, signature);
    } catch {
      return jsonError(400, "invalid_signature", "Invalid Stripe signature", requestId);
    }

    const db = getDb();
    const result = handleStripeWebhook(
      db,
      event as {
        id: string;
        type: string;
        data: {
          object: {
            id?: string;
            amount?: number;
            currency?: string;
            metadata?: Record<string, string>;
          };
        };
      },
      requestId,
    );

    return jsonOk({ received: true, duplicate: result.duplicate }, { requestId });
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
