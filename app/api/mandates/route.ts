import { z } from "zod";

import { requireHumanSession } from "../../../src/auth/session.ts";
import { withDatabase } from "../../../src/db.ts";
import { ok, rateLimit, readJson, route } from "../../../src/http.ts";
import { createMandate } from "../../../src/procurement/mandates.ts";

export const runtime = "nodejs";

export function POST(request: Request) {
  return route(async (requestId) => {
    const actor = await requireHumanSession(request, {
      permission: "mandates:write",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `mandates:${actor.subject}`, 10);
      const input = await readJson(request, z.unknown());
      return ok(await createMandate(database, actor, input, requestId), 201);
    });
  });
}
