import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  AuthError,
  createBearerVerifier,
  verifyAuth0Bearer,
  type ActorType,
} from "../src/auth/context.ts";

const issuer = "https://mandate-tests.auth0.com/";
const audience = "https://api.mandate.test";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const verify = createBearerVerifier({ issuer, audience, key: publicKey });
const buyerRequirements = {
  actorTypes: ["buyer_agent"] as const,
  scopes: ["orders:create"] as const,
};

async function token(
  claims: {
    audience?: string;
    organizationId?: unknown;
    actorType?: ActorType | "unknown";
    scope?: string;
  } = {},
) {
  return new SignJWT({
    org_id: claims.organizationId ?? "org_buyer_test",
    actor_type: claims.actorType ?? "buyer_agent",
    scope: claims.scope ?? "offers:read orders:create",
  })
    .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(issuer)
    .setAudience(claims.audience ?? audience)
    .setSubject("buyer-agent@test")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

test("returns a frozen actor only from verified claims", async () => {
  const actor = await verify(`Bearer ${await token()}`, buyerRequirements);

  assert.deepEqual(actor, {
    subject: "buyer-agent@test",
    organizationId: "org_buyer_test",
    actorType: "buyer_agent",
    scopes: ["offers:read", "orders:create"],
  });
  assert.ok(Object.isFrozen(actor));
  assert.ok(Object.isFrozen(actor.scopes));
});

test("rejects the wrong audience", async () => {
  await assert.rejects(
    verify(`Bearer ${await token({ audience: "https://other.test" })}`, buyerRequirements),
    (error: unknown) => error instanceof AuthError && error.code === "invalid_token",
  );
});

test("rejects an invalid organization claim", async () => {
  await assert.rejects(
    verify(`Bearer ${await token({ organizationId: 42 })}`, buyerRequirements),
    (error: unknown) => error instanceof AuthError && error.code === "invalid_token",
  );
});

test("rejects an actor not allowed by the route", async () => {
  await assert.rejects(
    verify(`Bearer ${await token({ actorType: "supplier_agent" })}`, buyerRequirements),
    (error: unknown) => error instanceof AuthError && error.code === "forbidden",
  );
});

test("rejects a missing required scope", async () => {
  await assert.rejects(
    verify(`Bearer ${await token({ scope: "offers:read" })}`, buyerRequirements),
    (error: unknown) => error instanceof AuthError && error.code === "forbidden",
  );
});

test("production verification fails closed without Auth0 configuration", async () => {
  const domain = process.env.AUTH0_DOMAIN;
  const configuredAudience = process.env.AUTH0_AUDIENCE;
  delete process.env.AUTH0_DOMAIN;
  delete process.env.AUTH0_AUDIENCE;
  try {
    await assert.rejects(
      verifyAuth0Bearer(`Bearer ${await token()}`, buyerRequirements),
      (error: unknown) =>
        error instanceof AuthError && error.code === "invalid_configuration",
    );
  } finally {
    if (domain === undefined) delete process.env.AUTH0_DOMAIN;
    else process.env.AUTH0_DOMAIN = domain;
    if (configuredAudience === undefined) delete process.env.AUTH0_AUDIENCE;
    else process.env.AUTH0_AUDIENCE = configuredAudience;
  }
});
