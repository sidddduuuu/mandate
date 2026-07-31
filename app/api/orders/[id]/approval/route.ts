import { z } from "zod";

import { requireHumanSession } from "../../../../../src/auth/session.ts";
import { withDatabase } from "../../../../../src/db.ts";
import {
  ok,
  rateLimit,
  readJson,
  route,
} from "../../../../../src/http.ts";
import { settleOrderFromWallet } from "../../../../../src/payments/wallet.ts";
import {
  decideApproval,
  getApprovalDecision,
} from "../../../../../src/procurement/approvals.ts";

export const runtime = "nodejs";

type Context = Readonly<{ params: Promise<{ id: string }> }>;

export function GET(request: Request, context: Context) {
  return route(async () => {
    const actor = await requireHumanSession(request, {
      permission: "approvals:read",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `approvals:read:${actor.subject}`, 120);
      const { id } = await context.params;
      const response = ok(await getApprovalDecision(database, actor, id));
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
  });
}

export function POST(request: Request, context: Context) {
  return route(async (requestId) => {
    const actor = await requireHumanSession(request, {
      permission: "approvals:decide",
    });
    return withDatabase(async (database) => {
      await rateLimit(database, `approvals:decide:${actor.subject}`, 30);
      const input = await readJson(request, z.unknown());
      const { id } = await context.params;
      const result = await decideApproval(
        database,
        actor,
        id,
        input,
        requestId,
      );
      if (result.initiatePayment) {
        await settleOrderFromWallet(database, id, requestId);
      }
      const response = ok({
        ...result.approval,
        replayed: result.replayed,
      });
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
  });
}
