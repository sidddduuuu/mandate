import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeDatabase,
  withImmediateTransaction,
} from "../src/db.ts";

const now = "2026-07-30T12:00:00.000Z";
const later = "2027-07-30T12:00:00.000Z";
const policyHash = "a".repeat(64);
const requestHash = "b".repeat(64);

test("schema enforces tenant, mandate, order, and audit invariants", () => {
  const db = initializeDatabase(":memory:");
  const organization = db.prepare(
    "INSERT INTO organizations (id, auth0_org_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  withImmediateTransaction(db, () => {
    organization.run("buyer", "org_buyer", "Buyer", "buyer", now);
    organization.run("supplier", "org_supplier", "Supplier", "supplier", now);
  });
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.throws(() =>
    organization.run("bad-kind", "org_bad", "Bad", "merchant", now),
  );

  db.prepare(`
    INSERT INTO catalog_items (
      id, supplier_organization_id, sku, product_key, category, unit,
      unit_price, currency, advisory_quantity, valid_from, valid_until,
      display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "offer", "supplier", "avo-18", "hass-avocado", "produce", "case",
    1200, "USD", 20, now, later, "Hass avocados", now, now,
  );
  assert.throws(
    () => db.prepare("DELETE FROM organizations WHERE id = ?").run("supplier"),
  );

  const mandate = db.prepare(`
    INSERT INTO mandates (
      id, buyer_organization_id, version, state, valid_from, valid_until,
      policy_json, schema_version, policy_hash, created_by_subject, created_at
    ) VALUES (?, 'buyer', ?, 'active', ?, ?, '{}', 1, ?, 'approver', ?)
  `);
  mandate.run("mandate-1", 1, now, later, policyHash, now);
  assert.throws(() =>
    mandate.run("mandate-2", 2, now, later, "c".repeat(64), now),
  );

  const order = db.prepare(`
    INSERT INTO orders (
      id, buyer_organization_id, supplier_organization_id, requester_subject,
      mandate_id, mandate_version, mandate_hash, catalog_item_id,
      catalog_item_version, sku, product_key, category, unit, unit_price,
      quantity, currency, total, delivery_location_id, status, policy_decision,
      policy_reasons_json, idempotency_key, request_hash, approval_expires_at,
      created_at, updated_at
    ) VALUES (
      ?, 'buyer', 'supplier', 'agent', 'mandate-1', 1, ?, 'offer', 1,
      'avo-18', 'hass-avocado', 'produce', 'case', 1200, 2, 'USD', ?,
      'kitchen', 'awaiting_approval', 'require_approval',
      '["ORDER_LIMIT_EXCEEDED"]', ?, ?, ?, ?, ?
    )
  `);
  order.run("order-1", policyHash, 2400, "key-1", requestHash, later, now, now);
  assert.throws(() =>
    order.run("order-2", policyHash, 2400, "key-1", requestHash, later, now, now),
  );
  assert.throws(() =>
    order.run("order-3", policyHash, 1, "key-2", requestHash, later, now, now),
  );

  db.prepare(`
    INSERT INTO audit_events (
      aggregate_type, aggregate_id, organization_id, event_type, actor_type,
      actor_subject, request_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("order", "order-1", "buyer", "order.created", "buyer_agent",
    "agent", "request-1", "{}", now);
  assert.throws(
    () => db.prepare("UPDATE audit_events SET event_type = ?").run("changed"),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_events").run(),
    /append-only/,
  );

  assert.throws(() =>
    withImmediateTransaction(db, () => {
      organization.run("rolled-back", "org_rolled_back", "Rolled back", "buyer", now);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM organizations WHERE id = ?")
      .get("rolled-back")?.count,
    0,
  );
  db.close();
});

test("file databases use WAL", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-schema-"));
  const db = initializeDatabase(join(directory, "mandate.sqlite"));
  context.after(() => {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  });

  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
});
