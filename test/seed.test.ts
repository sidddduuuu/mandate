import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { initializeDatabase } from "../src/db.ts";
import {
  seedDemoDatabase,
  type DemoSeedConfig,
} from "../scripts/seed.ts";

const config: DemoSeedConfig = {
  buyerAuth0OrgId: "org_juniper",
  supplierAuth0OrgIds: {
    greenline: "org_greenline",
    suncrest: "org_suncrest",
    orchard: "org_orchard",
  },
};

test("seed creates deterministic demo data idempotently", async () => {
  const database = initializeDatabase(":memory:");
  const first = await seedDemoDatabase(database, config);
  const snapshot = {
    organizations: database
      .prepare(
        "SELECT id, auth0_org_id, name, kind FROM organizations ORDER BY id",
      )
      .all(),
    offers: database
      .prepare(`
        SELECT id, supplier_organization_id, sku, product_key, category, unit,
          unit_price, currency, active, version
        FROM catalog_items ORDER BY unit_price, supplier_organization_id
      `)
      .all(),
    mandates: database
      .prepare(`
        SELECT id, buyer_organization_id, version, state, policy_json,
          schema_version, policy_hash
        FROM mandates
      `)
      .all(),
    orders: database
      .prepare(`
        SELECT buyer_organization_id, supplier_organization_id, quantity,
          total, status, policy_decision
        FROM orders
      `)
      .all()
      .map((order) => ({ ...order })),
  };

  assert.equal(snapshot.organizations.length, 4);
  assert.equal(snapshot.offers.length, 9);
  assert.ok(
    snapshot.offers.every(
      (offer) =>
        offer.category === "produce" &&
        offer.unit === "case" &&
        offer.currency === "USD" &&
        offer.active === 1 &&
        offer.version === 1,
    ),
  );
  assert.deepEqual(
    snapshot.offers
      .filter((offer) => offer.product_key === "hass-avocado")
      .map((offer) => offer.unit_price),
    [2_133, 2_233, 2_300],
  );

  const mandate = snapshot.mandates[0];
  assert.equal(snapshot.mandates.length, 1);
  assert.equal(mandate.state, "active");
  assert.equal(
    mandate.policy_hash,
    createHash("sha256")
      .update(mandate.policy_json as string)
      .digest("hex"),
  );
  assert.equal(first.policyHash, mandate.policy_hash);
  assert.deepEqual(snapshot.orders, [
    {
      buyer_organization_id: "buyer-juniper",
      supplier_organization_id: "supplier-greenline",
      quantity: 18,
      total: 38_394,
      status: "awaiting_approval",
      policy_decision: "require_approval",
    },
  ]);
  assert.deepEqual(JSON.parse(mandate.policy_json as string), {
    allowedCategories: ["produce"],
    allowedDeliveryLocationIds: ["mission-district-kitchen"],
    allowedSupplierOrgIds: [
      "supplier-greenline",
      "supplier-orchard",
      "supplier-suncrest",
    ],
    autonomousOrderLimitMinor: 25_000,
    budgetWindow: {
      end: "2099-01-01T00:00:00.000Z",
      limitMinor: 500_000,
      start: "2026-01-01T00:00:00.000Z",
    },
    currency: "USD",
    hardExceptionLimitMinor: 100_000,
  });

  const second = await seedDemoDatabase(database, config);
  assert.equal(second.policyHash, first.policyHash);
  assert.deepEqual(
    database
      .prepare(
        "SELECT id, auth0_org_id, name, kind FROM organizations ORDER BY id",
      )
      .all(),
    snapshot.organizations,
  );
  assert.deepEqual(
    database
      .prepare(`
        SELECT id, supplier_organization_id, sku, product_key, category, unit,
          unit_price, currency, active, version
        FROM catalog_items ORDER BY unit_price, supplier_organization_id
      `)
      .all(),
    snapshot.offers,
  );
  assert.deepEqual(
    database
      .prepare(`
        SELECT id, buyer_organization_id, version, state, policy_json,
          schema_version, policy_hash
        FROM mandates
      `)
      .all(),
    snapshot.mandates,
  );
  assert.deepEqual(
    database
      .prepare(`
        SELECT buyer_organization_id, supplier_organization_id, quantity,
          total, status, policy_decision
        FROM orders
      `)
      .all()
      .map((order) => ({ ...order })),
    snapshot.orders,
  );
  database.close();
});

test("seed rejects missing or duplicate authoritative organization IDs", async () => {
  const database = initializeDatabase(":memory:");
  await assert.rejects(
    async () =>
      seedDemoDatabase(database, {
        ...config,
        buyerAuth0OrgId: "",
      }),
    /buyerAuth0OrgId/,
  );
  await assert.rejects(
    async () =>
      seedDemoDatabase(database, {
        ...config,
        supplierAuth0OrgIds: {
          ...config.supplierAuth0OrgIds,
          greenline: config.buyerAuth0OrgId,
        },
      }),
    /must be unique/,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM organizations").get()
      ?.count,
    0,
  );
  database.close();
});

test("seed CLI fails clearly when required environment is missing", () => {
  const script = new URL("../scripts/seed.ts", import.meta.url);
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", script.pathname],
      { encoding: "utf8", env },
    );

  const noDatabase = run({ NODE_ENV: "test", PATH: process.env.PATH });
  assert.notEqual(noDatabase.status, 0);
  assert.match(noDatabase.stderr, /AUTH0_BUYER_ORG_ID is required/);

  const noDatabaseUrl = run({
    NODE_ENV: "test",
    PATH: process.env.PATH,
    AUTH0_BUYER_ORG_ID: "org_buyer",
    AUTH0_GREENLINE_ORG_ID: "org_greenline",
    AUTH0_SUNCREST_ORG_ID: "org_suncrest",
    AUTH0_ORCHARD_ORG_ID: "org_orchard",
  });
  assert.notEqual(noDatabaseUrl.status, 0);
  assert.match(noDatabaseUrl.stderr, /DATABASE_URL is required/);
});
