import { getConfig } from "@/lib/config";
import { AppError, jsonOk } from "@/lib/http";
import { readJson, withApi } from "@/lib/api";
import { advanceDelivery, serializeDelivery } from "@/store/operations";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      if (!getConfig().AUTH_TEST_MODE && actor.actorType !== "agent") {
        throw new AppError(
          403,
          "forbidden",
          "Advancing delivery from the UI requires AUTH_TEST_MODE",
        );
      }
      const { id } = await context.params;
      const body = await readJson(request);
      const delivery = advanceDelivery(db, actor, id, requestId, body);
      return jsonOk({ delivery: serializeDelivery(delivery) }, { requestId });
    },
    {
      humanPermission: "approvals:decide",
      csrf: true,
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
