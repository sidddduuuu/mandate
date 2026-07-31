import { requireHumanSession } from "../../../src/auth/session.ts";
import { withDatabase } from "../../../src/db.ts";
import { ok, rateLimit, route } from "../../../src/http.ts";
import { listPendingApprovals } from "../../../src/procurement/approvals.ts";

export const runtime = "nodejs";

export function GET(request: Request) {
  return route(async () => {
    const actor = await requireHumanSession(request, {
      permission: "approvals:read",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `approvals:read:${actor.subject}`, 120);
      const response = ok(await listPendingApprovals(database, actor));
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
  });
}
