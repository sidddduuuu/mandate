import { jwtVerify } from "jose";
import { getConfig } from "@/config";

export type HumanActor = {
  organizationId: string;
  subject: string;
  permissions: Set<string>;
};

export class SessionError extends Error {
  constructor(readonly status: 401 | 403, readonly code: string) {
    super(code);
  }
}

function cookie(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
}

export async function requireMandateWriter(request: Request): Promise<HumanActor> {
  if (request.headers.has("authorization")) {
    throw new SessionError(403, "browser_session_required");
  }
  const token = cookie(request, "mandate_session");
  if (!token) throw new SessionError(401, "missing_session");
  const secret = process.env.AUTH0_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH0_SECRET must be at least 32 characters");

  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: getConfig().issuer,
      audience: "mandate:web",
      algorithms: ["HS256"],
      requiredClaims: ["sub", "exp", "org_id"],
    }));
  } catch {
    throw new SessionError(401, "invalid_session");
  }
  const organization = getConfig().organizations.find(
    ({ auth0_org_id }) => auth0_org_id === payload.org_id,
  );
  if (!organization || organization.kind !== "buyer") {
    throw new SessionError(403, "buyer_organization_required");
  }
  const rawPermissions: unknown[] = Array.isArray(payload.permissions)
    ? payload.permissions
    : [];
  const values = rawPermissions.filter(
    (value: unknown): value is string => typeof value === "string",
  );
  const permissions = new Set<string>(values);
  if (!permissions.has("mandates:write")) {
    throw new SessionError(403, "insufficient_permission");
  }
  return {
    organizationId: organization.id,
    subject: payload.sub!,
    permissions,
  };
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_BASE_URL || new URL(request.url).origin;
  if (!origin || origin !== new URL(expected).origin) {
    throw new SessionError(403, "csrf_failed");
  }
}
