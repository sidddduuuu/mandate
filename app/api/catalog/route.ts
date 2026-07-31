import { z } from "zod";

import { verifyAuth0Bearer } from "../../../src/auth/context.ts";
import { updateCatalog } from "../../../src/catalog/catalog.ts";
import { withDatabase } from "../../../src/db.ts";
import { ok, rateLimit, readJson, route } from "../../../src/http.ts";

export const runtime = "nodejs";

export function PUT(request: Request) {
  return route(async (requestId) => {
    const actor = await verifyAuth0Bearer(
      request.headers.get("authorization"),
      { actorTypes: ["supplier_agent"], scopes: ["catalog:write"] },
    );
    return withDatabase(async (database) => {
      await rateLimit(database, `catalog:${actor.subject}`, 30);
      const input = await readJson(request, z.unknown());
      return ok(await updateCatalog(database, actor, input, requestId));
    });
  });
}
