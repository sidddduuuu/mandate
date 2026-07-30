import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ApiError, rateLimit, readJson } from "../src/http.ts";

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

test("rateLimit rejects only after the configured count", () => {
  const subject = `subject-${crypto.randomUUID()}`;
  rateLimit(subject, 2, 1_000, 100);
  rateLimit(subject, 2, 1_000, 100);
  assert.throws(
    () => rateLimit(subject, 2, 1_000, 100),
    (error: unknown) =>
      error instanceof ApiError && error.code === "RATE_LIMITED",
  );
});
