import { createRemoteJWKSet, jwtVerify } from "jose";
import { getConfig } from "@/config";
import { audit } from "@/db";

export type Actor = {
  clientId: string;
  organizationId: string;
  subject: string;
  type: "buyer" | "supplier";
  scopes: Set<string>;
};

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: string,
    readonly organizationId?: string,
  ) {
    super(code);
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

function keys(issuer: string) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
    jwksIssuer = issuer;
  }
  return jwks;
}

export async function requireSupplier(request: Request): Promise<Actor> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new AuthError(401, "missing_bearer_token");
  }

  const config = getConfig();
  let payload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), keys(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp"],
    }));
  } catch {
    throw new AuthError(401, "invalid_access_token");
  }

  const azp = typeof payload.azp === "string" ? payload.azp : undefined;
  const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
  if (!azp && !clientId) throw new AuthError(401, "missing_client_identity");
  if (azp && clientId && azp !== clientId) {
    throw new AuthError(401, "ambiguous_client_identity");
  }

  const identity = config.clients[azp || clientId!];
  if (!identity) throw new AuthError(403, "unknown_client_identity");
  if (
    typeof payload.org_id === "string" &&
    !config.organizations.some(
      (organization) =>
        organization.id === identity.organization_id &&
        organization.auth0_org_id === payload.org_id,
    )
  ) {
    throw new AuthError(403, "organization_mismatch", identity.organization_id);
  }

  const scopeText = typeof payload.scope === "string" ? payload.scope : "";
  const scopes = new Set<string>(scopeText.split(/\s+/).filter(Boolean));
  if (identity.actor_type !== "supplier") {
    throw new AuthError(403, "wrong_actor_type", identity.organization_id);
  }
  if (!scopes.has("catalog:write")) {
    throw new AuthError(403, "insufficient_scope", identity.organization_id);
  }

  return {
    clientId: azp || clientId!,
    organizationId: identity.organization_id,
    subject: payload.sub!,
    type: identity.actor_type,
    scopes,
  };
}

export function auditAuthFailure(error: AuthError, id: string) {
  audit({
    organizationId: error.organizationId,
    eventType: "authorization.denied",
    actorType: "unknown",
    requestId: id,
    payload: { reason: error.code },
  });
}
