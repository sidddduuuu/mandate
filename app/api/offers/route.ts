import { verifyAuth0Bearer } from "../../../src/auth/context.ts";
import { findEligibleOffers } from "../../../src/catalog/catalog.ts";
import { withDatabase } from "../../../src/db.ts";
import { ok, rateLimit, route } from "../../../src/http.ts";

export const runtime = "nodejs";

export function GET(request: Request) {
  return route(async () => {
    const actor = await verifyAuth0Bearer(
      request.headers.get("authorization"),
      { actorTypes: ["buyer_agent"], scopes: ["offers:read"] },
    );
    const query = new URL(request.url).searchParams;
    return withDatabase(async (database) => {
      await rateLimit(database, `offers:${actor.subject}`, 120);
      const offers = await findEligibleOffers(database, actor, {
        productKey: query.get("product_key"),
        unit: query.get("unit"),
        quantity: Number(query.get("quantity")),
        deliveryLocationId: query.get("delivery_location_id"),
      });
      return ok(offers);
    });
  });
}
