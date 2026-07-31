import assert from "node:assert/strict";
import test from "node:test";

import { getAuth0Client } from "../src/auth/client.ts";

test("browser Auth0 login does not require an API audience", async () => {
  const previous = Object.fromEntries(
    [
      "AUTH0_DOMAIN",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_SECRET",
      "AUTH0_AUDIENCE",
      "APP_BASE_URL",
    ].map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    AUTH0_DOMAIN: "mandate-test.auth0.com",
    AUTH0_CLIENT_ID: "client-test",
    AUTH0_CLIENT_SECRET: "client-secret-test",
    AUTH0_SECRET: "a".repeat(64),
    APP_BASE_URL: "http://localhost:3000",
  });
  delete process.env.AUTH0_AUDIENCE;
  try {
    const client = getAuth0Client();
    const response = await client.middleware(
      new Request("http://localhost:3000/auth/callback"),
    );
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Authentication failed");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
