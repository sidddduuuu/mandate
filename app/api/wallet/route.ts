import { requireHumanSession } from "../../../src/auth/session.ts";
import { withDatabase } from "../../../src/db.ts";
import { ok, rateLimit, route } from "../../../src/http.ts";
import { getWallet } from "../../../src/payments/wallet.ts";

export const runtime = "nodejs";

export function GET(request: Request) {
  return route(async () => {
    const actor = await requireHumanSession(request, {
      permission: "approvals:read",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `wallet:read:${actor.subject}`, 120);
      const response = ok(await getWallet(database, actor));
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
  });
}
