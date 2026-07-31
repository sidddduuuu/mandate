import { verifyAuth0Bearer } from "../../../../src/auth/context.ts";
import { withDatabase } from "../../../../src/db.ts";
import { ok, rateLimit, route } from "../../../../src/http.ts";
import { getOrder } from "../../../../src/procurement/orders.ts";

export const runtime = "nodejs";

type Context = Readonly<{ params: Promise<{ id: string }> }>;

export function GET(request: Request, context: Context) {
  return route(async () => {
    const actor = await verifyAuth0Bearer(
      request.headers.get("authorization"),
      {
        actorTypes: ["buyer_agent", "supplier_agent"],
        scopes: ["orders:read"],
      },
    );
    const { id } = await context.params;
    return withDatabase(async (database) => {
      await rateLimit(database, `orders:read:${actor.subject}`, 120);
      const response = ok(await getOrder(database, actor, id));
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
  });
}
