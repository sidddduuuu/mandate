import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "@/config";

const globalDb = globalThis as typeof globalThis & {
  mandateDb?: DatabaseSync;
  mandateDbPath?: string;
};

function seed(db: DatabaseSync) {
  const config = getConfig();
  const addOrganization = db.prepare(`
    INSERT OR IGNORE INTO organizations (id, auth0_org_id, name, kind)
    VALUES (?, ?, ?, ?)
  `);
  const getOrganization = db.prepare(`
    SELECT auth0_org_id, name, kind FROM organizations WHERE id = ?
  `);
  const addSku = db.prepare(`
    INSERT OR IGNORE INTO catalog_items
      (supplier_organization_id, sku, product_key, category, unit)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getSku = db.prepare(`
    SELECT product_key, category, unit FROM catalog_items
    WHERE supplier_organization_id = ? AND sku = ?
  `);

  for (const organization of config.organizations) {
    addOrganization.run(
      organization.id,
      organization.auth0_org_id,
      organization.name,
      organization.kind,
    );
    const stored = getOrganization.get(organization.id) as
      | { auth0_org_id: string; name: string; kind: string }
      | undefined;
    if (
      !stored ||
      stored.auth0_org_id !== organization.auth0_org_id ||
      stored.name !== organization.name ||
      stored.kind !== organization.kind
    ) {
      throw new Error(`Organization seed mismatch: ${organization.id}`);
    }
  }

  for (const item of config.registeredSkus) {
    addSku.run(
      item.organization_id,
      item.sku,
      item.product_key,
      item.category,
      item.unit,
    );
    const stored = getSku.get(item.organization_id, item.sku) as
      | { product_key: string; category: string; unit: string }
      | undefined;
    if (
      !stored ||
      stored.product_key !== item.product_key ||
      stored.category !== item.category ||
      stored.unit !== item.unit
    ) {
      throw new Error(`Registered SKU seed mismatch: ${item.sku}`);
    }
  }
}

function migrate(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      auth0_org_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('buyer', 'supplier'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS catalog_items (
      supplier_organization_id TEXT NOT NULL REFERENCES organizations(id),
      sku TEXT NOT NULL,
      product_key TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      unit_price_minor INTEGER,
      currency TEXT,
      advisory_quantity INTEGER,
      valid_from TEXT,
      valid_until TEXT,
      display_name TEXT,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at TEXT,
      PRIMARY KEY (supplier_organization_id, sku),
      CHECK (unit_price_minor IS NULL OR unit_price_minor BETWEEN 1 AND 1000000000),
      CHECK (advisory_quantity IS NULL OR advisory_quantity BETWEEN 0 AND 1000000)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id),
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_subject TEXT,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
    BEFORE UPDATE ON audit_events BEGIN
      SELECT RAISE(ABORT, 'audit_events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
    BEFORE DELETE ON audit_events BEGIN
      SELECT RAISE(ABORT, 'audit_events are append-only');
    END;
  `);
}

export function getDb(): DatabaseSync {
  const path = getConfig().databasePath;
  if (globalDb.mandateDb && globalDb.mandateDbPath === path) return globalDb.mandateDb;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrate(db);
  seed(db);
  globalDb.mandateDb = db;
  globalDb.mandateDbPath = path;
  return db;
}

export function now(): string {
  return process.env.FIXED_NOW || new Date().toISOString();
}

export function audit(input: {
  organizationId?: string;
  eventType: string;
  actorType: string;
  actorSubject?: string;
  requestId: string;
  payload: Record<string, unknown>;
}) {
  getDb()
    .prepare(`
      INSERT INTO audit_events
        (organization_id, event_type, actor_type, actor_subject, request_id, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.organizationId ?? null,
      input.eventType,
      input.actorType,
      input.actorSubject ?? null,
      input.requestId,
      JSON.stringify(input.payload),
      now(),
    );
}
