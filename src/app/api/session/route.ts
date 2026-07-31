import { authenticateRequest } from "@/auth/context";
import { getDb } from "@/db";
import { getAuth0Client } from "@/lib/auth0";
import { getRequestId, jsonOk, toErrorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Shows the current human Auth0 Organization session as a Mandate actor.
 * Useful for verifying org-bound login before approving orders.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const db = getDb();
    const actor = await authenticateRequest(db, request, requestId);
    const auth0 = getAuth0Client();
    const session = auth0 ? await auth0.getSession() : null;

    return jsonOk(
      {
        actor: {
          actor_type: actor.actorType,
          subject: actor.subject,
          organization_id: actor.organizationId,
          auth0_org_id: actor.auth0OrgId,
          permissions: [...actor.permissions].sort(),
          scopes: [...actor.scopes].sort(),
        },
        auth0_user: session?.user
          ? {
              sub: session.user.sub,
              email: session.user.email,
              name: session.user.name,
              org_id: session.user.org_id ?? null,
            }
          : null,
      },
      { requestId },
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
