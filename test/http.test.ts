import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AuthError } from "../src/auth/context.ts";
import { initializeDatabase } from "../src/db.ts";
import {
  ApiError,
  parseRequest,
  rateLimit,
  readJson,
  route,
} from "../src/http.ts";

test("readJson validates bodies and enforces the byte limit", async () => {
  const schema = z.object({ quantity: z.number().int().positive() }).strict();
  const request = new Request("http://localhost/api/orders", {
    method: "POST",
    body: JSON.stringify({ quantity: 18 }),
  });

  assert.deepEqual(await readJson(request, schema), { quantity: 18 });

  await assert.rejects(
    readJson(
      new Request("http://localhost", { method: "POST", body: "{}" }),
      schema,
    ),
    (error: unknown) =>
      error instanceof ApiError && error.code === "INVALID_REQUEST",
  );
});

test("rateLimit rejects only after the configured count", async (context) => {
  const database = initializeDatabase(":memory:");
  context.after(() => database.close());
  const subject = `subject-${crypto.randomUUID()}`;
  await rateLimit(database, subject, 2);
  await rateLimit(database, subject, 2);
  await assert.rejects(
    rateLimit(database, subject, 2),
    (error: unknown) =>
      error instanceof ApiError && error.code === "RATE_LIMITED",
  );
  database.prepare(
    "UPDATE rate_limit_windows SET resets_at = ? WHERE key = ?",
  ).run("1970-01-01T00:00:00.000Z", subject);
  await rateLimit(database, subject, 2);
});

test("route returns sanitized authentication errors", async () => {
  const response = await route(async () => {
    throw new AuthError("invalid_token");
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual((await response.json()).error.code, "UNAUTHORIZED");
});

test("route distinguishes authorization and configuration failures", async () => {
  const forbidden = await route(async () => {
    throw new AuthError("forbidden");
  });
  const unavailable = await route(async () => {
    throw new AuthError("invalid_configuration");
  });

  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "AUTH_UNAVAILABLE");
});

test("route sanitizes external validation details", async () => {
  const response = await route(async () => {
    parseRequest(
      z.object({ quantity: z.number().positive() }),
      { quantity: -1 },
    );
    throw new Error("unreachable");
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INVALID_REQUEST",
      message: "Request is invalid",
      request_id: response.headers.get("x-request-id"),
    },
  });
});

test("route treats internal schema failures as server errors", async () => {
  const response = await route(async () => {
    z.object({ quantity: z.number().positive() }).parse({ quantity: -1 });
    throw new Error("unreachable");
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed",
      request_id: response.headers.get("x-request-id"),
    },
  });
});
