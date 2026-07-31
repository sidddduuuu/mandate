import assert from "node:assert/strict";
import test from "node:test";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server.js";

import { config } from "../proxy.ts";

const matches = (pathname: string) =>
  unstable_doesMiddlewareMatch({
    config,
    url: new URL(pathname, "http://localhost:3000").toString(),
  });

test("Auth0 proxy only wraps human-session routes", () => {
  assert.equal(matches("/"), false);
  assert.equal(matches("/api/webhooks/stripe"), false);
  assert.equal(matches("/api/orders"), false);
  assert.equal(matches("/api/orders/order-1"), false);

  assert.equal(matches("/auth/login"), true);
  assert.equal(matches("/auth/callback"), true);
  assert.equal(matches("/dashboard"), true);
  assert.equal(matches("/supplier/onboarding"), true);
  assert.equal(matches("/api/approvals"), true);
  assert.equal(matches("/api/mandates"), true);
  assert.equal(matches("/api/orders/order-1/approval"), true);
  assert.equal(matches("/api/suppliers/connect"), true);
});
