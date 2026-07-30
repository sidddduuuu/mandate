import { serializeMandate, createMandateVersion } from "@/procurement/mandates";
import { jsonOk } from "@/lib/http";
import { readJson, withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const body = await readJson(request);
      const mandate = createMandateVersion(db, actor, body, requestId);
      return jsonOk(serializeMandate(mandate), { status: 201, requestId });
    },
    {
      humanPermission: "mandates:write",
      csrf: true,
      rateLimit: { limit: 30, windowMs: 60_000 },
    },
  );
}
