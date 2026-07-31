import { requireHumanSession } from "../../../../src/auth/session.ts";
import { withDatabase } from "../../../../src/db.ts";
import { ok, rateLimit, route } from "../../../../src/http.ts";
import {
  createSupplierOnboardingSession,
  getSupplierPaymentStatus,
} from "../../../../src/payments/connect.ts";

export const runtime = "nodejs";

export function GET(request: Request) {
  return route(async () => {
    const actor = await requireHumanSession(request, { permission: "openid" });
    return withDatabase(async (database) => {
      await rateLimit(database, `supplier:connect:read:${actor.subject}`, 60);
      return ok(await getSupplierPaymentStatus(database, actor));
    });
  });
}

export function POST(request: Request) {
  return route(async (requestId) => {
    const actor = await requireHumanSession(request, { permission: "openid" });
    return withDatabase(async (database) => {
      await rateLimit(database, `supplier:connect:onboard:${actor.subject}`, 10);
      return ok(await createSupplierOnboardingSession(
        database,
        actor,
        requestId,
      ), 201);
    });
  });
}
