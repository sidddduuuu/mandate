import { listAuditForOrg } from "@/audit/audit";
import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, actor, requestId }) => {
      const events = listAuditForOrg(db, actor.organizationId).map((e) => ({
        id: e.id,
        aggregate_type: e.aggregate_type,
        aggregate_id: e.aggregate_id,
        event_type: e.event_type,
        actor_type: e.actor_type,
        actor_subject: e.actor_subject,
        request_id: e.request_id,
        payload: JSON.parse(e.payload_json) as unknown,
        created_at: e.created_at,
      }));
      return jsonOk({ events }, { requestId });
    },
    {
      humanPermission: "orders:read",
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
