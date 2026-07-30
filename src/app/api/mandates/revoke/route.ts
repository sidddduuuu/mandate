import { revokeActiveMandate, serializeMandate } from "@/procurement/mandates";
import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const mandate = revokeActiveMandate(db, actor, requestId);
      return jsonOk(serializeMandate(mandate), { requestId });
    },
    {
      humanPermission: "mandates:write",
      csrf: true,
      rateLimit: { limit: 20, windowMs: 60_000 },
    },
  );
}
