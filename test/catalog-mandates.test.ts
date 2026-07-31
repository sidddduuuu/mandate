import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  type ActorContext,
  type ActorType,
} from "../src/auth/context.ts";
import {
  findEligibleOffers,
  updateCatalog,
} from "../src/catalog/catalog.ts";
import {
  initializeDatabase,
  type TestDatabase,
} from "../src/db.ts";
import { createMandate } from "../src/procurement/mandates.ts";

const validFrom = "2026-01-01T00:00:00.000Z";
const validUntil = "2027-01-01T00:00:00.000Z";
const now = new Date("2026-07-30T12:00:00.000Z");

function actor(
  organizationId: string,
  actorType: ActorType,
  scopes: readonly string[],
): ActorContext {
  return Object.freeze({
    subject: `${actorType}@test`,
    organizationId,
    actorType,
    scopes: Object.freeze([...scopes]),
  });
}

async function database(): Promise<TestDatabase> {
  const db = initializeDatabase(":memory:");
  await db.run(
    "INSERT INTO organizations (id, auth0_org_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    "buyer", "org_buyer", "Buyer", "buyer", now.toISOString(),
  );
  await db.run(
    "INSERT INTO organizations (id, auth0_org_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    "buyer-2", "org_buyer_2", "Buyer 2", "buyer", now.toISOString(),
  );
  for (const id of ["supplier-a", "supplier-b", "supplier-c"]) {
    await db.run(
      "INSERT INTO organizations (id, auth0_org_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
      id, `org_${id}`, id, "supplier", now.toISOString(),
    );
  }
  const insertItem = `
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (?, ?, ?, 'hass-avocado', 'produce', 'case', ?, 'USD', 20, ?, ?, ?, ?, ?)
  `;
  await db.run(insertItem,
    "offer-a", "supplier-a", "sku-a", 1000, validFrom, validUntil,
    "Avocados A", now.toISOString(), now.toISOString());
  await db.run(insertItem,
    "offer-b", "supplier-b", "sku-b", 1000, validFrom, validUntil,
    "Avocados B", now.toISOString(), now.toISOString());
  await db.run(insertItem,
    "offer-c", "supplier-c", "sku-c", 500, validFrom, validUntil,
    "Avocados C", now.toISOString(), now.toISOString());
  return db;
}

function publication(sku: string, unitPriceMinor = 900) {
  return {
    sku,
    unitPriceMinor,
    currency: "USD",
    advisoryQuantity: 18,
    validFrom,
    validUntil,
    displayName: "Hass avocados",
    description: null,
    active: true,
  };
}

function policy(suppliers = ["supplier-b", "supplier-a"]) {
  return {
    currency: "USD",
    autonomousOrderLimitMinor: 25_000,
    hardExceptionLimitMinor: 100_000,
    budgetWindow: {
      start: validFrom,
      end: validUntil,
      limitMinor: 500_000,
    },
    allowedSupplierOrgIds: suppliers,
    allowedCategories: ["produce"],
    allowedDeliveryLocationIds: ["kitchen"],
  };
}

test("catalog updates only owned registered SKU mutable fields atomically", async () => {
  const db = await database();
  const supplier = actor("org_supplier-a", "supplier_agent", ["catalog:write"]);
  const updated = await updateCatalog(
    db, supplier, { items: [publication("sku-a")] }, "request-1", now,
  );
  assert.equal(updated[0]?.version, 2);
  assert.equal(updated[0]?.category, "produce");

  await assert.rejects(updateCatalog(
    db, supplier,
    { items: [{ ...publication("sku-a"), category: "dairy" }] },
    "request-2", now,
  ));
  await assert.rejects(updateCatalog(
    db, supplier,
    { items: [publication("sku-a", 800), publication("unknown")] },
    "request-3", now,
  ), /unknown registered SKU/);
  assert.equal(
    (await db.get(
      "SELECT version FROM catalog_items WHERE id = 'offer-a'",
    ))?.version,
    2,
  );
  await assert.rejects(updateCatalog(
    db, actor("org_supplier-b", "supplier_agent", ["catalog:write"]),
    { items: [publication("sku-a")] }, "request-4", now,
  ), /unknown registered SKU/);
  assert.equal(
    (await db.get("SELECT count(*) AS count FROM audit_events"))?.count,
    1,
  );
  db.close();
});

test("mandates hash canonically and supersede only the actor tenant", async () => {
  const db = await database();
  const human = actor("org_buyer", "human", ["mandates:write"]);
  const first = await createMandate(
    db, human, { validFrom, validUntil, policy: policy() }, "request-1", now,
  );
  await db.run(`
    INSERT INTO orders (
      id, buyer_organization_id, supplier_organization_id, requester_subject,
      mandate_id, mandate_version, mandate_hash, catalog_item_id,
      catalog_item_version, sku, product_key, category, unit, unit_price,
      quantity, currency, total, delivery_location_id, status, policy_decision,
      policy_reasons_json, idempotency_key, request_hash, approval_expires_at,
      created_at, updated_at
    ) VALUES (
      'waiting-order', 'buyer', 'supplier-a', 'buyer-agent', ?, 1, ?,
      'offer-a', 1, 'sku-a', 'hass-avocado', 'produce', 'case', 1000, 10,
      'USD', 10000, 'kitchen', 'awaiting_approval', 'require_approval',
      '["ORDER_LIMIT_EXCEEDED"]',
      '00000000-0000-4000-8000-000000000301', ?, ?, ?, ?
    )
  `,
    first.id,
    first.policyHash,
    "d".repeat(64),
    "2026-07-30T13:00:00.000Z",
    now.toISOString(),
    now.toISOString(),
  );
  const second = await createMandate(
    db, human,
    { validFrom, validUntil, policy: policy(["supplier-a", "supplier-b"]) },
    "request-2", now,
  );

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(first.policyHash, second.policyHash);
  assert.deepEqual(
    (await db.all("SELECT version, state FROM mandates ORDER BY version"))
      .map((row) => ({ ...row })),
    [
      { version: 1, state: "superseded" },
      { version: 2, state: "active" },
    ],
  );
  assert.equal(
    (await db.get(
      "SELECT status FROM orders WHERE id = 'waiting-order'",
    ))?.status,
    "stale",
  );
  assert.equal(
    (await db.get(
      "SELECT count(*) AS count FROM audit_events WHERE aggregate_id = 'waiting-order' AND event_type = 'order.stale'",
    ))?.count,
    1,
  );
  await assert.rejects(createMandate(
    db,
    actor("org_supplier-a", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: policy() },
    "request-3", now,
  ), (error: unknown) =>
    error instanceof AuthError && error.code === "forbidden");
  await assert.rejects(
    createMandate(
      db,
      human,
      {
        validFrom,
        validUntil,
        policy: policy(["supplier-a", "supplier-missing"]),
      },
      "request-4",
      now,
    ),
    /unknown supplier/,
  );
  assert.equal(
    (await db.get(
      "SELECT count(*) AS count FROM mandates WHERE state = 'active'",
    ))?.count,
    1,
  );
  db.close();
});

test("offers exclude cross-tenant policy and break cheapest ties by supplier", async () => {
  const db = await database();
  await createMandate(
    db,
    actor("org_buyer", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: policy() },
    "request-1",
    now,
  );
  const query = {
    productKey: "hass-avocado",
    unit: "case",
    quantity: 10,
    deliveryLocationId: "kitchen",
  };
  const offers = await findEligibleOffers(
    db, actor("org_buyer", "buyer_agent", ["offers:read"]), query, now,
  );

  assert.deepEqual(
    offers.map(({ supplierOrganizationId }) => supplierOrganizationId),
    ["supplier-a", "supplier-b"],
  );
  assert.equal(offers[0]?.totalMinor, 10_000);
  const policyJson = (await db.get(
    "SELECT policy_json FROM mandates WHERE buyer_organization_id = 'buyer'",
  ))?.policy_json;
  assert.equal(typeof policyJson, "string");
  await db.run(`
    INSERT INTO mandates (
      id, buyer_organization_id, version, state, valid_from, valid_until,
      policy_json, schema_version, policy_hash, created_by_subject, created_at
    ) VALUES (
      'unsupported-mandate', 'buyer-2', 1, 'active', ?, ?, ?, 2, ?,
      'test', ?
    )
  `,
    validFrom,
    validUntil,
    policyJson as string,
    "e".repeat(64),
    now.toISOString(),
  );
  assert.deepEqual(
    await findEligibleOffers(
      db, actor("org_buyer_2", "buyer_agent", ["offers:read"]), query, now,
    ),
    [],
  );
  db.close();
});

test("offers are unavailable outside the mandate budget window", async () => {
  const db = await database();
  const inactivePolicy = policy();
  inactivePolicy.budgetWindow.start = "2026-08-01T00:00:00.000Z";
  await createMandate(
    db,
    actor("org_buyer", "human", ["mandates:write"]),
    { validFrom, validUntil, policy: inactivePolicy },
    "request-inactive",
    now,
  );
  assert.deepEqual(
    await findEligibleOffers(
      db,
      actor("org_buyer", "buyer_agent", ["offers:read"]),
      {
        productKey: "hass-avocado",
        unit: "case",
        quantity: 10,
        deliveryLocationId: "kitchen",
      },
      now,
    ),
    [],
  );
  db.close();
});
