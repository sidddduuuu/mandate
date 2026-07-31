import { authenticateRequest } from "@/auth/context";
import { getDb } from "@/db";
import { getAuth0Client } from "@/lib/auth0";
import { getRequestId, jsonOk, toErrorResponse } from "@/lib/http";
import { readLocalSessionFromCookieHeader } from "@/lib/local-session";

export const runtime = "nodejs";

/**
 * Shows the current human session as a Mandate actor (Auth0 or local demo cookie).
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const db = getDb();
    const actor = await authenticateRequest(db, request, requestId);
    const auth0 = getAuth0Client();
    const auth0Session = auth0 ? await auth0.getSession() : null;
    const local = readLocalSessionFromCookieHeader(request.headers.get("cookie"));
    const user = auth0Session?.user
      ? {
          sub: auth0Session.user.sub,
          email: auth0Session.user.email,
          name: auth0Session.user.name,
          org_id: auth0Session.user.org_id ?? null,
        }
      : local?.user ?? null;

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
        auth0_user: user,
      },
      { requestId },
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
