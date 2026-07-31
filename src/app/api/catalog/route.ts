import { AuthError, auditAuthFailure, requireSupplier } from "@/auth";
import { CatalogError, parseCatalog, replaceCatalog } from "@/catalog/catalog";
import { getDb } from "@/db";
import { fail, ok, requestId } from "@/http";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  const id = requestId();
  let actor;
  try {
    actor = await requireSupplier(request);
  } catch (error) {
    if (error instanceof AuthError) {
      try {
        auditAuthFailure(error, id);
      } catch {
        return fail(500, "internal_error", "Request could not be completed", id);
      }
      return fail(error.status, error.code, "Request is not authorized", id);
    }
    return fail(500, "internal_error", "Request could not be completed", id);
  }

  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 64 * 1024) {
      return fail(413, "request_too_large", "Catalog payload is too large", id);
    }
    const body = JSON.parse(text) as unknown;
    const items = parseCatalog(body);
    return ok(
      replaceCatalog({
        db: getDb(),
        organizationId: actor.organizationId,
        actorSubject: actor.subject,
        requestId: id,
        items,
      }),
      id,
    );
  } catch (error) {
    if (error instanceof CatalogError) {
      return fail(422, error.code, "Catalog payload is invalid", id);
    }
    if (error instanceof SyntaxError) {
      return fail(400, "invalid_json", "Request body must be valid JSON", id);
    }
    return fail(500, "internal_error", "Request could not be completed", id);
  }
}
