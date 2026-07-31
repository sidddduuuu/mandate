import type { ActorContext } from "./context.ts";
import { AuthError } from "./context.ts";
import { getAuth0Client } from "./client.ts";
import { requireSameOrigin } from "../http.ts";

export type HumanSessionRequirements = Readonly<{
  permission: string;
}>;

type HumanClaims = Readonly<{
  sub?: unknown;
  org_id?: unknown;
  permissions?: unknown;
  scope?: unknown;
}>;

type SessionClaims = Readonly<{
  user: Readonly<Record<string, unknown>>;
  tokenSet: Readonly<{ scope?: unknown }>;
}>;

const DEMO_ORGANIZATION_ID = "demo_buyer_juniper";
const DEMO_PERMISSIONS = Object.freeze([
  "mandates:write",
  "approvals:read",
  "approvals:decide",
  "orders:read",
]);

export function localDemoAuthorizationEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production"
    && process.env.LOCAL_DEMO_AUTHZ === "true"
  );
}

export function humanClaimsFromSession(session: SessionClaims): HumanClaims {
  const demo = localDemoAuthorizationEnabled();
  return Object.freeze({
    sub: session.user.sub,
    org_id: session.user.org_id ?? (demo ? DEMO_ORGANIZATION_ID : undefined),
    permissions: demo ? DEMO_PERMISSIONS : session.user.permissions,
    scope: [session.user.scope, session.tokenSet.scope]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
  });
}

export function actorFromHumanClaims(
  claims: unknown,
  requirements: HumanSessionRequirements,
): ActorContext {
  if (!requirements.permission || /\s/.test(requirements.permission)) {
    throw new AuthError("invalid_configuration");
  }
  if (!claims || typeof claims !== "object") {
    throw new AuthError("invalid_token");
  }

  const { sub, org_id: organizationId, permissions, scope } = claims as HumanClaims;
  if (
    typeof sub !== "string" ||
    !sub.trim() ||
    typeof organizationId !== "string" ||
    !organizationId.trim()
  ) {
    throw new AuthError("invalid_token");
  }
  if (
    permissions !== undefined &&
    (!Array.isArray(permissions) ||
      permissions.some((permission) => typeof permission !== "string" || !permission))
  ) {
    throw new AuthError("invalid_token");
  }
  if (scope !== undefined && typeof scope !== "string") {
    throw new AuthError("invalid_token");
  }

  const scopes = Object.freeze([
    ...new Set([
      ...((permissions as string[] | undefined) ?? []),
      ...(typeof scope === "string" ? scope.trim().split(/\s+/).filter(Boolean) : []),
    ]),
  ]);
  if (!scopes.includes(requirements.permission)) {
    throw new AuthError("forbidden");
  }

  return Object.freeze({
    subject: sub,
    organizationId,
    actorType: "human",
    scopes,
  });
}

export async function requireHumanSession(
  request: Request,
  requirements: HumanSessionRequirements,
): Promise<ActorContext> {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    requireSameOrigin(request);
  }

  let session;
  try {
    session = await getAuth0Client().getSession();
  } catch (cause) {
    if (cause instanceof AuthError) throw cause;
    throw new AuthError("invalid_token", { cause });
  }
  if (!session) throw new AuthError("invalid_token");

  return actorFromHumanClaims(humanClaimsFromSession(session), requirements);
}
