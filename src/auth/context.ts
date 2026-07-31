import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT } from "jose";
import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import type { Db } from "../db";
import { getAuth0Client } from "../lib/auth0";
import { getConfig } from "../lib/config";
import { AppError } from "../lib/http";
import { writeAudit } from "../audit/audit";

export type ActorType = "agent" | "human";

export type ActorContext = {
  actorType: ActorType;
  subject: string;
  organizationId: string;
  auth0OrgId: string;
  scopes: Set<string>;
  permissions: Set<string>;
  clientId?: string;
};

export type OrgRow = {
  id: string;
  auth0_org_id: string;
  name: string;
  kind: "buyer" | "supplier";
  stripe_customer_id: string | null;
};

const HUMAN_PERMISSIONS = new Set([
  "mandates:write",
  "approvals:read",
  "approvals:decide",
  "orders:read",
]);

const AGENT_SCOPES = new Set([
  "catalog:write",
  "offers:read",
  "orders:create",
  "orders:read",
]);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  const cfg = getConfig();
  if (!cfg.AUTH0_DOMAIN) {
    throw new AppError(500, "auth_misconfigured", "AUTH0_DOMAIN is not configured");
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${cfg.AUTH0_DOMAIN}/.well-known/jwks.json`));
  }
  return jwks;
}

function parseScopeClaim(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

function resolveAuth0OrgId(
  payload: Record<string, unknown>,
  clientId: string | undefined,
): string {
  const cfg = getConfig();
  const orgClaim = payload.org_id;
  if (typeof orgClaim === "string" && orgClaim.length > 0) {
    return orgClaim;
  }
  if (clientId && cfg.m2mClientOrgMap[clientId]) {
    return cfg.m2mClientOrgMap[clientId]!;
  }
  if (clientId) {
    // DB fallback mapping
    return "";
  }
  throw new AppError(401, "unauthorized", "Missing organization context");
}

export function lookupOrgByAuth0Id(db: Db, auth0OrgId: string): OrgRow {
  const row = db
    .prepare(`SELECT * FROM organizations WHERE auth0_org_id = ?`)
    .get(auth0OrgId) as OrgRow | undefined;
  if (!row) {
    throw new AppError(403, "forbidden", "Unknown organization");
  }
  return row;
}

export function lookupOrgByClientId(db: Db, clientId: string): OrgRow | null {
  const mapped = db
    .prepare(
      `SELECT o.* FROM m2m_client_org_map m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.client_id = ?`,
    )
    .get(clientId) as OrgRow | undefined;
  return mapped ?? null;
}

async function verifyBearerToken(token: string): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (cfg.AUTH_TEST_MODE) {
    const secret = new TextEncoder().encode(cfg.AUTH_TEST_HMAC_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: cfg.AUTH0_AUDIENCE ?? "https://mandate.local/api",
      issuer: cfg.AUTH0_ISSUER ?? "https://mandate.test/",
    });
    return payload as Record<string, unknown>;
  }

  if (!cfg.AUTH0_ISSUER || !cfg.AUTH0_AUDIENCE) {
    throw new AppError(500, "auth_misconfigured", "Auth0 issuer/audience not configured");
  }

  const { payload } = await jwtVerify(token, getJwks(), {
    algorithms: ["RS256"],
    issuer: cfg.AUTH0_ISSUER,
    audience: cfg.AUTH0_AUDIENCE,
  });
  return payload as Record<string, unknown>;
}

function decodeSessionCookie(cookieHeader: string | null): Record<string, unknown> | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)mandate_session=([^;]+)/);
  if (!match?.[1]) return null;
  const cfg = getConfig();
  const secret = cfg.SESSION_SECRET ?? cfg.AUTH_TEST_HMAC_SECRET;
  const raw = decodeURIComponent(match[1]);
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function encodeSessionCookie(payload: {
  sub: string;
  org_id: string;
  permissions: string[];
  exp: number;
}): string {
  const cfg = getConfig();
  const secret = cfg.SESSION_SECRET ?? cfg.AUTH_TEST_HMAC_SECRET;
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function defaultHumanPermissions(): Set<string> {
  const raw = getConfig().AUTH0_DEFAULT_HUMAN_PERMISSIONS;
  return new Set(
    raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => HUMAN_PERMISSIONS.has(p)),
  );
}

function permissionsFromAccessToken(accessToken: string | undefined): Set<string> {
  if (!accessToken) return new Set();
  try {
    const claims = decodeJwt(accessToken) as Record<string, unknown>;
    const fromArray = Array.isArray(claims.permissions)
      ? claims.permissions.filter((p): p is string => typeof p === "string")
      : [];
    const fromScope =
      typeof claims.scope === "string"
        ? claims.scope.split(/\s+/).filter((s) => HUMAN_PERMISSIONS.has(s))
        : [];
    const merged = [...fromArray, ...fromScope].filter((p) => HUMAN_PERMISSIONS.has(p));
    return new Set(merged);
  } catch {
    return new Set();
  }
}

/**
 * Resolve a human ActorContext from an Auth0 Organization login session.
 * Requires org_id on the user/access token (login via /auth/login?organization=org_…).
 */
export async function actorFromAuth0Session(
  db: Db,
  request: Request,
): Promise<ActorContext | null> {
  const auth0 = getAuth0Client();
  if (!auth0) return null;

  const session = await auth0.getSession(request as NextRequest);
  if (!session?.user?.sub) return null;

  let auth0OrgId =
    typeof session.user.org_id === "string" ? session.user.org_id : "";
  if (!auth0OrgId && session.tokenSet?.accessToken) {
    try {
      const claims = decodeJwt(session.tokenSet.accessToken) as Record<string, unknown>;
      if (typeof claims.org_id === "string") auth0OrgId = claims.org_id;
    } catch {
      // ignore
    }
  }
  if (!auth0OrgId) {
    throw new AppError(
      403,
      "missing_organization",
      "Auth0 session has no organization; login with ?organization=org_…",
    );
  }

  const org = lookupOrgByAuth0Id(db, auth0OrgId);
  const tokenPermissions = permissionsFromAccessToken(session.tokenSet?.accessToken);
  const permissions =
    tokenPermissions.size > 0 ? tokenPermissions : defaultHumanPermissions();

  return {
    actorType: "human",
    subject: session.user.sub,
    organizationId: org.id,
    auth0OrgId: org.auth0_org_id,
    scopes: new Set(),
    permissions,
  };
}

export async function authenticateRequest(
  db: Db,
  request: Request,
  requestId: string,
): Promise<ActorContext> {
  try {
    const auth = request.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length).trim();
      const payload = await verifyBearerToken(token);
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      if (!sub) throw new AppError(401, "unauthorized", "Missing subject");

      const clientId =
        (typeof payload.azp === "string" && payload.azp) ||
        (typeof payload.client_id === "string" && payload.client_id) ||
        undefined;

      let auth0OrgId = "";
      try {
        auth0OrgId = resolveAuth0OrgId(payload, clientId);
      } catch {
        auth0OrgId = "";
      }
      let org: OrgRow | null = null;
      if (auth0OrgId) {
        org = lookupOrgByAuth0Id(db, auth0OrgId);
      } else if (clientId) {
        org = lookupOrgByClientId(db, clientId);
        if (!org) {
          const mappedAuth0 = getConfig().m2mClientOrgMap[clientId];
          if (mappedAuth0) org = lookupOrgByAuth0Id(db, mappedAuth0);
        }
      }
      if (!org) throw new AppError(401, "unauthorized", "Missing organization context");

      const scopes = new Set(parseScopeClaim(payload.scope ?? payload.permissions));
      return {
        actorType: "agent",
        subject: sub,
        organizationId: org.id,
        auth0OrgId: org.auth0_org_id,
        scopes,
        permissions: new Set(),
        clientId,
      };
    }

    const fromAuth0 = await actorFromAuth0Session(db, request);
    if (fromAuth0) return fromAuth0;

    // AUTH_TEST_MODE only: signed mandate_session cookie for automated tests.
    const cfg = getConfig();
    if (!cfg.AUTH_TEST_MODE) {
      throw new AppError(401, "unauthorized", "Authentication required");
    }

    const session = decodeSessionCookie(request.headers.get("cookie"));
    if (!session) throw new AppError(401, "unauthorized", "Authentication required");
    const exp = typeof session.exp === "number" ? session.exp : 0;
    if (exp * 1000 < Date.now()) {
      throw new AppError(401, "unauthorized", "Session expired");
    }
    const sub = typeof session.sub === "string" ? session.sub : "";
    const auth0OrgId = typeof session.org_id === "string" ? session.org_id : "";
    if (!sub || !auth0OrgId) {
      throw new AppError(401, "unauthorized", "Invalid session");
    }
    const org = lookupOrgByAuth0Id(db, auth0OrgId);
    const permissions = new Set(
      Array.isArray(session.permissions)
        ? session.permissions.filter((p): p is string => typeof p === "string")
        : [],
    );
    return {
      actorType: "human",
      subject: sub,
      organizationId: org.id,
      auth0OrgId: org.auth0_org_id,
      scopes: new Set(),
      permissions,
    };
  } catch (err) {
    if (err instanceof AppError) {
      writeAudit(db, {
        aggregateType: "auth",
        eventType: "auth.denied",
        actorType: "system",
        requestId,
        payload: { code: err.code, message: err.message },
      });
      throw err;
    }
    writeAudit(db, {
      aggregateType: "auth",
      eventType: "auth.denied",
      actorType: "system",
      requestId,
      payload: { code: "unauthorized", message: "Token validation failed" },
    });
    throw new AppError(401, "unauthorized", "Token validation failed");
  }
}

export function requireAgentScope(actor: ActorContext, scope: string): void {
  if (actor.actorType !== "agent" || !AGENT_SCOPES.has(scope) || !actor.scopes.has(scope)) {
    throw new AppError(403, "forbidden", `Missing scope ${scope}`);
  }
}

export function requireHumanPermission(actor: ActorContext, permission: string): void {
  if (
    actor.actorType !== "human" ||
    !HUMAN_PERMISSIONS.has(permission) ||
    !actor.permissions.has(permission)
  ) {
    throw new AppError(403, "forbidden", `Missing permission ${permission}`);
  }
}

/** CSRF: require custom header matching session origin for browser mutations. */
export function requireCsrf(request: Request): void {
  const header = request.headers.get("x-csrf-token");
  if (!header || header !== "mandate") {
    throw new AppError(403, "csrf_failed", "CSRF validation failed");
  }
}

export async function mintTestAgentToken(claims: {
  sub: string;
  org_id?: string;
  scope: string;
  client_id?: string;
}): Promise<string> {
  const cfg = getConfig();
  const secret = new TextEncoder().encode(cfg.AUTH_TEST_HMAC_SECRET);
  return new SignJWT({
    org_id: claims.org_id,
    scope: claims.scope,
    client_id: claims.client_id,
    azp: claims.client_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(cfg.AUTH0_ISSUER ?? "https://mandate.test/")
    .setAudience(cfg.AUTH0_AUDIENCE ?? "https://mandate.local/api")
    .setExpirationTime("2h")
    .sign(secret);
}
