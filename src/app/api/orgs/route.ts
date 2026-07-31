import { jsonOk } from "@/lib/http";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";

/** Lists organizations for mandate authoring (supplier picker). */
export async function GET(request: Request): Promise<Response> {
  return withApi(
    request,
    async ({ db, requestId }) => {
      const rows = db
        .prepare(
          `SELECT id, auth0_org_id, name, kind FROM organizations ORDER BY kind, name`,
        )
        .all() as Array<{
        id: string;
        auth0_org_id: string;
        name: string;
        kind: "buyer" | "supplier";
      }>;
      return jsonOk(
        {
          organizations: rows.map((r) => ({
            id: r.id,
            auth0_org_id: r.auth0_org_id,
            name: r.name,
            kind: r.kind,
          })),
        },
        { requestId },
      );
    },
    {
      humanPermission: "mandates:write",
      rateLimit: { limit: 60, windowMs: 60_000 },
    },
  );
}
