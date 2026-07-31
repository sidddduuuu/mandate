import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../src/auth/context.ts";
import {
  actorFromHumanClaims,
  humanClaimsFromSession,
  localDemoAuthorizationEnabled,
  requireHumanSession,
} from "../src/auth/session.ts";
import { ApiError } from "../src/http.ts";

const claims = {
  sub: "auth0|human-test",
  org_id: "org_buyer_test",
  permissions: ["approvals:read"],
  scope: "openid orders:read",
};
const requirements = {
  permission: "approvals:read",
};

test("creates a frozen human actor from session claims", () => {
  const actor = actorFromHumanClaims(claims, requirements);

  assert.deepEqual(actor, {
    subject: "auth0|human-test",
    organizationId: "org_buyer_test",
    actorType: "human",
    scopes: ["approvals:read", "openid", "orders:read"],
  });
  assert.ok(Object.isFrozen(actor));
  assert.ok(Object.isFrozen(actor.scopes));
});

test("rejects a session without the requested permission", () => {
  assert.throws(
    () =>
      actorFromHumanClaims(claims, {
        ...requirements,
        permission: "approvals:decide",
      }),
    (error: unknown) => error instanceof AuthError && error.code === "forbidden",
  );
});

test("rejects missing identity claims", () => {
  assert.throws(
    () => actorFromHumanClaims({ org_id: "org_buyer_test" }, requirements),
    (error: unknown) =>
      error instanceof AuthError && error.code === "invalid_token",
  );
});

test("rejects cross-origin human mutations before reading a session", async () => {
  const appBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://mandate.test";
  try {
    await assert.rejects(
      requireHumanSession(
        new Request("https://mandate.test/api/approvals", {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        }),
        requirements,
      ),
      (error: unknown) =>
        error instanceof ApiError && error.code === "INVALID_ORIGIN",
    );
  } finally {
    if (appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = appBaseUrl;
  }
});

test("development demo keeps Auth0 identity and supplies local authorization", () => {
  const localDemoAuthz = process.env.LOCAL_DEMO_AUTHZ;
  process.env.LOCAL_DEMO_AUTHZ = "true";
  try {
    assert.equal(localDemoAuthorizationEnabled(), true);
    assert.deepEqual(
      humanClaimsFromSession({
        user: { sub: "auth0|real-user", name: "Maya Chen" },
        tokenSet: {},
      }),
      {
        sub: "auth0|real-user",
        org_id: "demo_buyer_juniper",
        permissions: [
          "mandates:write",
          "approvals:read",
          "approvals:decide",
          "orders:read",
        ],
        scope: "",
      },
    );
  } finally {
    if (localDemoAuthz === undefined) delete process.env.LOCAL_DEMO_AUTHZ;
    else process.env.LOCAL_DEMO_AUTHZ = localDemoAuthz;
  }
});
