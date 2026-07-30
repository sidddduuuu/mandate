import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
  type KeyInput,
} from "jose";

const ACTOR_TYPES = ["buyer_agent", "supplier_agent", "human"] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export type ActorContext = Readonly<{
  subject: string;
  organizationId: string;
  actorType: ActorType;
  scopes: readonly string[];
}>;

export type AuthRequirements = Readonly<{
  actorTypes: readonly ActorType[];
  scopes: readonly string[];
}>;

type VerifierConfig = Readonly<{
  issuer: string;
  audience: string;
  key: KeyInput | JWTVerifyGetKey;
}>;

type ActorClaims = JWTPayload & {
  org_id?: unknown;
  actor_type?: unknown;
  scope?: unknown;
};

export class AuthError extends Error {
  readonly code: "invalid_configuration" | "invalid_token" | "forbidden";

  constructor(
    code: "invalid_configuration" | "invalid_token" | "forbidden",
    options?: ErrorOptions,
  ) {
    super(code === "invalid_configuration" ? "Authentication unavailable" : "Unauthorized", options);
    this.name = "AuthError";
    this.code = code;
  }
}

export function createBearerVerifier(config: VerifierConfig) {
  if (!config.issuer || !config.audience) {
    throw new AuthError("invalid_configuration");
  }

  return async (
    authorization: string | null | undefined,
    requirements: AuthRequirements,
  ): Promise<ActorContext> => {
    if (
      requirements.actorTypes.length === 0 ||
      requirements.scopes.length === 0 ||
      requirements.actorTypes.some((type) => !ACTOR_TYPES.includes(type)) ||
      requirements.scopes.some((scope) => !scope || /\s/.test(scope))
    ) {
      throw new AuthError("invalid_configuration");
    }

    const token = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) {
      throw new AuthError("invalid_token");
    }

    let payload: ActorClaims;
    try {
      ({ payload } = await jwtVerify<ActorClaims>(token, config.key, {
        algorithms: ["RS256"],
        audience: config.audience,
        issuer: config.issuer,
        requiredClaims: ["exp", "sub", "org_id", "actor_type", "scope"],
      }));
    } catch (cause) {
      throw new AuthError("invalid_token", { cause });
    }

    const { sub, org_id: organizationId, actor_type: actorType, scope } = payload;
    if (
      typeof sub !== "string" ||
      !sub.trim() ||
      typeof organizationId !== "string" ||
      !organizationId.trim() ||
      typeof actorType !== "string" ||
      !ACTOR_TYPES.includes(actorType as ActorType) ||
      typeof scope !== "string"
    ) {
      throw new AuthError("invalid_token");
    }

    const scopes = Object.freeze([...new Set(scope.trim().split(/\s+/).filter(Boolean))]);
    if (!requirements.actorTypes.includes(actorType as ActorType)) {
      throw new AuthError("forbidden");
    }
    if (requirements.scopes.some((required) => !scopes.includes(required))) {
      throw new AuthError("forbidden");
    }

    return Object.freeze({
      subject: sub,
      organizationId,
      actorType: actorType as ActorType,
      scopes,
    });
  };
}

let cachedRemote:
  | Readonly<{ issuer: string; audience: string; verify: ReturnType<typeof createBearerVerifier> }>
  | undefined;

function productionVerifier() {
  const domain = process.env.AUTH0_DOMAIN?.trim();
  const audience = process.env.AUTH0_AUDIENCE?.trim();
  if (!domain || !audience) {
    throw new AuthError("invalid_configuration");
  }

  let url: URL;
  try {
    url = new URL(domain.includes("://") ? domain : `https://${domain}`);
  } catch (cause) {
    throw new AuthError("invalid_configuration", { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new AuthError("invalid_configuration");
  }

  const issuer = `${url.origin}/`;
  if (cachedRemote?.issuer !== issuer || cachedRemote.audience !== audience) {
    cachedRemote = Object.freeze({
      issuer,
      audience,
      verify: createBearerVerifier({
        issuer,
        audience,
        key: createRemoteJWKSet(new URL(".well-known/jwks.json", issuer)),
      }),
    });
  }
  return cachedRemote.verify;
}

export async function verifyAuth0Bearer(
  authorization: string | null | undefined,
  requirements: AuthRequirements,
): Promise<ActorContext> {
  return productionVerifier()(authorization, requirements);
}
