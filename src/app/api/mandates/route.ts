import { SessionError, requireMandateWriter, requireSameOrigin } from "@/auth/session";
import { audit, getDb } from "@/db";
import { fail, ok, requestId } from "@/http";
import { MandateError, createMandate, parseMandate } from "@/mandates/mandates";

export const runtime = "nodejs";

function formMandate(text: string) {
  const form = new URLSearchParams(text);
  const list = (name: string) =>
    (form.get(name) || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    valid_from: form.get("valid_from"),
    valid_until: form.get("valid_until"),
    currency: form.get("currency"),
    autonomous_limit_minor: Number(form.get("autonomous_limit_minor")),
    hard_limit_minor: Number(form.get("hard_limit_minor")),
    budget_window: {
      starts_at: form.get("budget_starts_at"),
      ends_at: form.get("budget_ends_at"),
      limit_minor: Number(form.get("budget_limit_minor")),
    },
    allowed_supplier_ids: list("allowed_supplier_ids"),
    allowed_categories: list("allowed_categories"),
    delivery_location_ids: list("delivery_location_ids"),
  };
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    requireSameOrigin(request);
    const actor = await requireMandateWriter(request);
    const text = await request.text();
    if (Buffer.byteLength(text) > 64 * 1024) {
      return fail(413, "request_too_large", "Mandate payload is too large", id);
    }
    const body = request.headers.get("content-type")?.startsWith("application/json")
      ? (JSON.parse(text) as unknown)
      : formMandate(text);
    const mandate = parseMandate(body);
    return ok(
      createMandate({
        db: getDb(),
        organizationId: actor.organizationId,
        creatorSubject: actor.subject,
        requestId: id,
        mandate,
      }),
      id,
      201,
    );
  } catch (error) {
    if (error instanceof SessionError) {
      try {
        audit({
          eventType: "authorization.denied",
          actorType: "human",
          requestId: id,
          payload: { reason: error.code },
        });
      } catch {
        return fail(500, "internal_error", "Request could not be completed", id);
      }
      return fail(error.status, error.code, "Request is not authorized", id);
    }
    if (error instanceof MandateError) {
      return fail(error.status, error.code, "Purchasing Mandate is invalid", id);
    }
    if (error instanceof SyntaxError) {
      return fail(400, "invalid_json", "Request body must be valid JSON", id);
    }
    return fail(500, "internal_error", "Request could not be completed", id);
  }
}
