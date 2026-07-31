import { z } from "zod";

import { requireHumanSession } from "../../../../src/auth/session.ts";
import { withDatabase } from "../../../../src/db.ts";
import {
  ok,
  rateLimit,
  readJson,
  route,
} from "../../../../src/http.ts";
import { createWalletCheckout } from "../../../../src/payments/stripe.ts";
import { createWalletTopUp } from "../../../../src/payments/wallet.ts";

export const runtime = "nodejs";

export function POST(request: Request) {
  return route(async (requestId) => {
    const actor = await requireHumanSession(request, {
      permission: "approvals:decide",
    });
    const input = await readJson(request, z.object({
      amountMinor: z.number().int().min(1_000).max(100_000),
    }).strict());
    return withDatabase(async (database) => {
      await rateLimit(database, `wallet:topup:${actor.subject}`, 10);
      const topup = await createWalletTopUp(
        database,
        actor,
        input.amountMinor,
        requestId,
      );
      const checkoutUrl = await createWalletCheckout(
        database,
        topup,
        requestId,
        new URL(request.url).origin,
      );
      return ok({ topupId: topup.id, checkoutUrl }, 201);
    });
  });
}
