PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  auth0_org_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('buyer', 'supplier')),
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS m2m_client_org_map (
  client_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  supplier_org_id TEXT NOT NULL REFERENCES organizations(id),
  sku TEXT NOT NULL,
  product_key TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  advisory_quantity INTEGER NOT NULL CHECK (advisory_quantity >= 0),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  UNIQUE (supplier_org_id, sku)
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'revoked')),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  autonomous_order_limit_minor INTEGER NOT NULL CHECK (autonomous_order_limit_minor > 0),
  hard_exception_limit_minor INTEGER NOT NULL CHECK (hard_exception_limit_minor > 0),
  budget_window_start TEXT NOT NULL,
  budget_window_end TEXT NOT NULL,
  budget_limit_minor INTEGER NOT NULL CHECK (budget_limit_minor > 0),
  allowed_supplier_org_ids_json TEXT NOT NULL,
  allowed_categories_json TEXT NOT NULL,
  allowed_delivery_location_ids_json TEXT NOT NULL,
  policy_schema_version INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (buyer_org_id, version),
  CHECK (hard_exception_limit_minor >= autonomous_order_limit_minor),
  CHECK (budget_window_end > budget_window_start),
  CHECK (valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS mandates_one_active_per_buyer
  ON mandates(buyer_org_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  supplier_org_id TEXT NOT NULL REFERENCES organizations(id),
  requester_subject TEXT NOT NULL,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  mandate_version INTEGER NOT NULL,
  mandate_policy_hash TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id),
  catalog_version INTEGER NOT NULL,
  sku TEXT NOT NULL,
  product_key TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  delivery_location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'denied',
    'awaiting_approval',
    'rejected',
    'expired',
    'stale',
    'payment_pending',
    'payment_failed',
    'paid',
    'cancelled'
  )),
  policy_decision TEXT NOT NULL CHECK (policy_decision IN ('allow', 'require_approval', 'deny')),
  policy_reasons_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  approval_expires_at TEXT,
  approval_actor_subject TEXT,
  approval_decided_at TEXT,
  approval_reason TEXT,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_create_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (buyer_org_id, requester_subject, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orders_buyer_status_idx ON orders(buyer_org_id, status);
CREATE INDEX IF NOT EXISTS orders_supplier_idx ON orders(supplier_org_id, status);
CREATE INDEX IF NOT EXISTS orders_approval_queue_idx ON orders(buyer_org_id, status, approval_expires_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  object_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT,
  organization_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system', 'stripe')),
  actor_subject TEXT,
  request_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- Buyer store stock levels (agent detects needs against reorder points).
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  product_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  location_id TEXT NOT NULL,
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  reorder_point INTEGER NOT NULL CHECK (reorder_point >= 0),
  target_quantity INTEGER NOT NULL CHECK (target_quantity >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (buyer_org_id, product_key, location_id)
);

CREATE INDEX IF NOT EXISTS inventory_buyer_idx
  ON inventory_items(buyer_org_id, location_id);

-- Agent-authored purchase list for the store owner.
CREATE TABLE IF NOT EXISTS purchase_needs (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
  product_key TEXT NOT NULL,
  unit TEXT NOT NULL,
  location_id TEXT NOT NULL,
  suggested_quantity INTEGER NOT NULL CHECK (suggested_quantity > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'ordered', 'dismissed')),
  order_id TEXT REFERENCES orders(id),
  detected_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS purchase_needs_buyer_status_idx
  ON purchase_needs(buyer_org_id, status);

-- Delivery tracking after payment; inventory is applied on delivered.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  supplier_org_id TEXT NOT NULL REFERENCES organizations(id),
  product_key TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'packing',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled'
  )),
  eta_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  inventory_applied INTEGER NOT NULL DEFAULT 0 CHECK (inventory_applied IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deliveries_buyer_status_idx
  ON deliveries(buyer_org_id, status);
