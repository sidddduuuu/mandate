import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  AuthError,
  type ActorContext,
  type ActorType,
} from "../src/auth/context.ts";
import {
  initializeDatabase,
  type TestDatabase,
} from "../src/db.ts";
import { ApiError } from "../src/http.ts";
import { createMandate } from "../src/procurement/mandates.ts";
import {
  createOrder,
  getOrder,
} from "../src/procurement/orders.ts";

const now = new Date("2026-07-30T12:00:00.000Z");
const validFrom = "2026-01-01T00:00:00.000Z";
const validUntil = "2027-01-01T00:00:00.000Z";

function actor(
  organizationId: string,
  actorType: ActorType,
  scopes: readonly string[],
  subject = `${actorType}@test`,
): ActorContext {
  return Object.freeze({
    organizationId,
    actorType,
    scopes: Object.freeze([...scopes]),
    subject,
  });
}

function orderInput(quantity = 10) {
  return {
    productKey: "hass-avocado",
    unit: "case",
    quantity,
    deliveryLocationId: "kitchen",
  };
}

function policy(
  overrides: Partial<{
    autonomousOrderLimitMinor: number;
    hardExceptionLimitMinor: number;
    budgetLimitMinor: number;
    budgetStart: string;
    budgetEnd: string;
  }> = {},
) {
  return {
    currency: "USD",
    autonomousOrderLimitMinor:
      overrides.autonomousOrderLimitMinor ?? 15_000,
    hardExceptionLimitMinor: overrides.hardExceptionLimitMinor ?? 30_000,
    budgetWindow: {
      start: overrides.budgetStart ?? validFrom,
      end: overrides.budgetEnd ?? validUntil,
      limitMinor: overrides.budgetLimitMinor ?? 100_000,
    },
    allowedSupplierOrgIds: ["supplier-a", "supplier-b"],
    allowedCategories: ["produce"],
    allowedDeliveryLocationIds: ["kitchen"],
  };
}

async function database(
  policyOverrides: Parameters<typeof policy>[0] = {},
  path = ":memory:",
): Promise<TestDatabase> {
  const database = initializeDatabase(path);
  const organization = database.prepare(`
    INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  organization.run("buyer", "org_buyer", "Buyer", "buyer", now.toISOString());
  organization.run(
    "buyer-2", "org_buyer_2", "Buyer 2", "buyer", now.toISOString(),
  );
  organization.run(
    "supplier-a", "org_supplier-a", "Supplier A", "supplier",
    now.toISOString(),
  );
  organization.run(
    "supplier-b", "org_supplier-b", "Supplier B", "supplier",
    now.toISOString(),
  );
  const offer = database.prepare(`
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (?, ?, ?, 'hass-avocado', 'produce', 'case', 1000, 'USD', 100,
      ?, ?, ?, ?, ?)
  `);
  offer.run(
    "offer-b", "supplier-b", "sku-b", validFrom, validUntil, "Avocados B",
    now.toISOString(), now.toISOString(),
  );
  offer.run(
    "offer-a", "supplier-a", "sku-a", validFrom, validUntil, "Avocados A",
    now.toISOString(), now.toISOString(),
  );
  await createMandate(
    database,
    actor("org_buyer", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: policy(policyOverrides) },
    "mandate-request",
    now,
  );
  return database;
}

const buyer = actor("org_buyer", "buyer_agent", [
  "orders:create",
  "orders:read",
]);

function orderWorker(
  databasePath: string,
  idempotencyKey: string,
  requestId: string,
  organizationId = "org_buyer",
  subject = "buyer_agent@test",
): Worker {
  return new Worker(new URL("./order-create-worker.ts", import.meta.url), {
    workerData: {
      databasePath,
      idempotencyKey,
      requestId,
      now: now.toISOString(),
      organizationId,
      subject,
    },
  });
}

test("orders select authoritative cheapest offers and persist all decisions", async () => {
  const db = await database();
  const allowed = await createOrder(
    db, buyer, orderInput(10),
    "00000000-0000-4000-8000-000000000001", "request-allow", now,
  );
  const approval = await createOrder(
    db, buyer, orderInput(20),
    "00000000-0000-4000-8000-000000000002", "request-approval", now,
  );
  const denied = await createOrder(
    db, buyer, orderInput(31),
    "00000000-0000-4000-8000-000000000003", "request-deny", now,
  );

  assert.equal(allowed.kind, "order");
  assert.equal(approval.kind, "order");
  assert.equal(denied.kind, "order");
  if (
    allowed.kind !== "order"
    || approval.kind !== "order"
    || denied.kind !== "order"
  ) throw new Error("Expected persisted orders");
  assert.equal(allowed.order.supplierOrganizationId, "supplier-a");
  assert.equal(allowed.order.totalMinor, 10_000);
  assert.equal(allowed.order.status, "payment_pending");
  assert.equal(approval.order.status, "awaiting_approval");
  assert.deepEqual(approval.order.policyReasonCodes, [
    "ORDER_LIMIT_EXCEEDED",
  ]);
  assert.match(approval.order.approvalExpiresAt ?? "", /Z$/);
  assert.equal(denied.order.status, "denied");
  assert.deepEqual(denied.order.policyReasonCodes, [
    "HARD_EXCEPTION_LIMIT_EXCEEDED",
  ]);
  assert.equal(
    db.prepare(`
      SELECT count(*) AS count FROM audit_events
      WHERE event_type = 'order.created'
    `).get()?.count,
    3,
  );
  assert.deepEqual(
    db.prepare(`
      SELECT event_type, count(*) AS count FROM audit_events
      WHERE event_type IN ('offer.selected', 'policy.evaluated')
      GROUP BY event_type ORDER BY event_type
    `).all().map((row) => [row.event_type, row.count]),
    [
      ["offer.selected", 3],
      ["policy.evaluated", 3],
    ],
  );
  db.close();
});

test("order idempotency replays the snapshot and rejects payload conflicts", async () => {
  const db = await database();
  const key = "00000000-0000-4000-8000-000000000010";
  const first = await createOrder(
    db, buyer, orderInput(), key, "request-1", now,
  );
  const replay = await createOrder(
    db, buyer, orderInput(), key, "request-2", now,
  );
  assert.equal(first.kind, "order");
  assert.equal(replay.kind, "order");
  if (first.kind !== "order" || replay.kind !== "order")
    throw new Error("Expected persisted orders");
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, first.order.id);
  await assert.rejects(
    createOrder(db, buyer, orderInput(11), key, "request-3", now),
    (error: unknown) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM orders").get()?.count,
    1,
  );
  assert.equal(
    db.prepare(`
      SELECT count(*) AS count FROM audit_events
      WHERE event_type = 'order.idempotency_conflict'
    `).get()?.count,
    1,
  );
  db.close();
});

test("buyer input rejects authoritative fields and unknown properties", async () => {
  const db = await database();
  await assert.rejects(createOrder(
    db,
    buyer,
    {
      ...orderInput(),
      supplierOrganizationId: "supplier-b",
      unitPriceMinor: 1,
    },
    "00000000-0000-4000-8000-000000000020",
    "request-extra",
    now,
  ));
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM orders").get()?.count,
    0,
  );
  db.close();
});

test("unexpired approval requests reserve the period budget", async () => {
  const db = await database({
    autonomousOrderLimitMinor: 15_000,
    hardExceptionLimitMinor: 50_000,
    budgetLimitMinor: 25_000,
  });
  const first = await createOrder(
    db, buyer, orderInput(20),
    "00000000-0000-4000-8000-000000000030", "request-first", now,
  );
  const second = await createOrder(
    db, buyer, orderInput(10),
    "00000000-0000-4000-8000-000000000031", "request-second", now,
  );
  assert.equal(first.kind, "order");
  assert.equal(second.kind, "order");
  if (first.kind !== "order" || second.kind !== "order")
    throw new Error("Expected persisted orders");
  assert.deepEqual(first.order.policyReasonCodes, ["ORDER_LIMIT_EXCEEDED"]);
  assert.deepEqual(second.order.policyReasonCodes, [
    "PERIOD_BUDGET_EXCEEDED",
  ]);
  assert.equal(second.order.status, "awaiting_approval");
  db.close();
});

test("expired approvals release their budget reservation", async () => {
  const db = await database({
    autonomousOrderLimitMinor: 15_000,
    hardExceptionLimitMinor: 50_000,
    budgetLimitMinor: 25_000,
  });
  const first = await createOrder(
    db, buyer, orderInput(20),
    "00000000-0000-4000-8000-000000000032", "request-first", now,
  );
  const afterExpiry = new Date("2026-07-30T12:31:00.000Z");
  const second = await createOrder(
    db, buyer, orderInput(10),
    "00000000-0000-4000-8000-000000000033", "request-second", afterExpiry,
  );
  assert.equal(first.kind, "order");
  assert.equal(second.kind, "order");
  if (first.kind !== "order" || second.kind !== "order")
    throw new Error("Expected persisted orders");
  assert.equal(first.order.status, "awaiting_approval");
  assert.equal(second.order.status, "payment_pending");
  assert.deepEqual(second.order.policyReasonCodes, []);
  db.close();
});

test("committed spend survives mandate version changes", async () => {
  const limits = {
    autonomousOrderLimitMinor: 15_000,
    hardExceptionLimitMinor: 50_000,
    budgetLimitMinor: 15_000,
  };
  const db = await database(limits);
  const first = await createOrder(
    db, buyer, orderInput(10),
    "00000000-0000-4000-8000-000000000034", "request-first", now,
  );
  await createMandate(
    db,
    actor("org_buyer", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: policy(limits) },
    "mandate-version-2",
    new Date("2026-07-30T12:05:00.000Z"),
  );
  const second = await createOrder(
    db, buyer, orderInput(10),
    "00000000-0000-4000-8000-000000000035",
    "request-second",
    new Date("2026-07-30T12:06:00.000Z"),
  );
  assert.equal(first.kind, "order");
  assert.equal(second.kind, "order");
  if (first.kind !== "order" || second.kind !== "order")
    throw new Error("Expected persisted orders");
  assert.equal(first.order.status, "payment_pending");
  assert.equal(second.order.status, "awaiting_approval");
  assert.deepEqual(second.order.policyReasonCodes, [
    "PERIOD_BUDGET_EXCEEDED",
  ]);
  assert.equal(second.order.mandateVersion, 2);
  db.close();
});

test("concurrent orders serialize at the remaining-budget boundary", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-orders-"));
  const databasePath = join(directory, "orders.sqlite");
  const db = await database({
    autonomousOrderLimitMinor: 15_000,
    hardExceptionLimitMinor: 50_000,
    budgetLimitMinor: 15_000,
  }, databasePath);
  db.close();
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const first = orderWorker(
    databasePath,
    "00000000-0000-4000-8000-000000000037",
    "request-concurrent-1",
  );
  const second = orderWorker(
    databasePath,
    "00000000-0000-4000-8000-000000000038",
    "request-concurrent-2",
  );
  await Promise.all([once(first, "message"), once(second, "message")]);
  const results = Promise.all([
    once(first, "message"),
    once(second, "message"),
  ]);
  first.postMessage("create");
  second.postMessage("create");
  const messages = (await results).map(([message]) =>
    message as { error?: string; status?: string }
  );
  assert.deepEqual(messages.map(({ error }) => error), [undefined, undefined]);
  assert.deepEqual(messages.map(({ status }) => status).sort(), [
    "awaiting_approval",
    "payment_pending",
  ]);
});

test("concurrent buyers cannot over-reserve one standing offer", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-reservations-"));
  const databasePath = join(directory, "orders.sqlite");
  const db = await database({}, databasePath);
  await createMandate(
    db,
    actor("org_buyer_2", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: policy() },
    "buyer-2-mandate",
    now,
  );
  await db.run(
    "UPDATE catalog_items SET advisory_quantity = 10 WHERE id = 'offer-a'",
  );
  await db.run("UPDATE catalog_items SET active = 0 WHERE id = 'offer-b'");
  db.close();
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const first = orderWorker(
    databasePath,
    "00000000-0000-4000-8000-000000000047",
    "reservation-1",
  );
  const second = orderWorker(
    databasePath,
    "00000000-0000-4000-8000-000000000048",
    "reservation-2",
    "org_buyer_2",
    "buyer-2-agent@test",
  );
  await Promise.all([once(first, "message"), once(second, "message")]);
  const results = Promise.all([once(first, "message"), once(second, "message")]);
  first.postMessage("create");
  second.postMessage("create");
  const messages = (await results).map(([message]) =>
    message as { error?: string; status?: string }
  );
  assert.deepEqual(messages.map(({ error }) => error), [undefined, undefined]);
  assert.deepEqual(messages.map(({ status }) => status).sort(), [
    "denied",
    "payment_pending",
  ]);
  const verify = initializeDatabase(databasePath);
  assert.equal((await verify.get(`
    SELECT COALESCE(SUM(quantity), 0) AS quantity FROM offer_reservations
    WHERE status = 'reserved'
  `))?.quantity, 10);
  verify.close();
});

test("inactive budget windows deny before offer selection", async () => {
  const db = await database({
    budgetStart: "2026-08-01T00:00:00.000Z",
    budgetEnd: validUntil,
  });
  const input = { ...orderInput(), productKey: "missing-product" };
  const result = await createOrder(
    db, buyer, input,
    "00000000-0000-4000-8000-000000000036",
    "request-inactive",
    now,
  );
  assert.equal(result.kind, "denial");
  if (result.kind !== "denial") throw new Error("Expected request denial");
  assert.deepEqual(result.denial.policyReasonCodes, ["MANDATE_INACTIVE"]);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM orders").get()?.count,
    0,
  );
  db.close();
});

test("reads hide other tenants and restrict assigned supplier fields", async () => {
  const db = await database();
  const created = await createOrder(
    db, buyer, orderInput(),
    "00000000-0000-4000-8000-000000000040", "request-read", now,
  );
  if (created.kind !== "order") throw new Error("Expected persisted order");

  const full = await getOrder(db, buyer, created.order.id);
  assert.equal(full.view, "buyer");
  assert.equal("requestHash" in full, false);
  assert.equal("idempotencyKey" in full, false);
  assert.equal("stripePaymentIntentId" in full, false);
  await assert.rejects(
    getOrder(
      db,
      actor("org_buyer_2", "buyer_agent", ["orders:read"]),
      created.order.id,
    ),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  const supplier = actor(
    "org_supplier-a",
    "supplier_agent",
    ["orders:read"],
  );
  await assert.rejects(
    getOrder(db, supplier, created.order.id),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  db.prepare(`
    UPDATE orders SET
      status = 'paid',
      stripe_create_started_at = ?,
      stripe_payment_intent_id = 'pi_test_paid',
      updated_at = ?
    WHERE id = ?
  `).run(now.toISOString(), now.toISOString(), created.order.id);
  const fulfillment = await getOrder(db, supplier, created.order.id);
  assert.deepEqual(Object.keys(fulfillment).sort(), [
    "createdAt",
    "deliveryLocationId",
    "id",
    "productKey",
    "quantity",
    "sku",
    "status",
    "unit",
    "updatedAt",
    "view",
  ]);
  await assert.rejects(
    getOrder(
      db,
      actor("org_supplier-b", "supplier_agent", ["orders:read"]),
      created.order.id,
    ),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await assert.rejects(
    getOrder(
      db,
      actor("org_supplier-a", "supplier_agent", []),
      created.order.id,
    ),
    (error: unknown) =>
      error instanceof AuthError && error.code === "forbidden",
  );
  db.close();
});

test("non-persistable denials are typed, audited, and idempotent", async () => {
  const db = await database();
  const key = "00000000-0000-4000-8000-000000000050";
  const missing = orderInput();
  missing.productKey = "missing-product";
  const first = await createOrder(db, buyer, missing, key, "request-1", now);
  const replay = await createOrder(db, buyer, missing, key, "request-2", now);

  assert.deepEqual(first, {
    kind: "denial",
    replayed: false,
    denial: {
      status: "denied",
      policyDecision: "deny",
      policyReasonCodes: ["NO_ELIGIBLE_OFFER"],
      idempotencyKey: key,
      createdAt: now.toISOString(),
    },
  });
  assert.equal(replay.kind, "denial");
  assert.equal(replay.replayed, true);
  await assert.rejects(
    createOrder(
      db,
      buyer,
      { ...missing, quantity: 2 },
      key,
      "request-3",
      now,
    ),
    (error: unknown) =>
      error instanceof ApiError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM orders").get()?.count,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM order_denials").get()?.count,
    1,
  );
  db.close();
});
