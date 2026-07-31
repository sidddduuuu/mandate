PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 512),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  resets_at TEXT NOT NULL CHECK (
    resets_at GLOB '????-??-??T??:??:??*Z'
  )
) STRICT;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  auth0_org_id TEXT NOT NULL UNIQUE CHECK (length(auth0_org_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('buyer', 'supplier')),
  stripe_customer_id TEXT UNIQUE
    CHECK (stripe_customer_id IS NULL OR length(stripe_customer_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_payment_accounts (
  supplier_organization_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL UNIQUE
    CHECK (length(stripe_account_id) BETWEEN 1 AND 128),
  onboarding_status TEXT NOT NULL CHECK (onboarding_status IN (
    'not_started', 'requirements_due', 'pending', 'complete', 'restricted'
  )),
  requirements_status TEXT NOT NULL CHECK (requirements_status IN (
    'unknown', 'due', 'pending', 'clear'
  )),
  stripe_transfers_status TEXT NOT NULL CHECK (stripe_transfers_status IN (
    'inactive', 'pending', 'active', 'restricted', 'unsupported'
  )),
  payout_ready INTEGER NOT NULL CHECK (payout_ready IN (0, 1)),
  last_stripe_event_created_at TEXT CHECK (
    last_stripe_event_created_at IS NULL
    OR last_stripe_event_created_at GLOB '????-??-??T??:??:??*Z'
  ),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND updated_at >= created_at
  ),
  FOREIGN KEY (supplier_organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_accounts (
  organization_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 10000000000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND updated_at >= created_at
  ),
  FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_topups (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  organization_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 100 AND 100000000),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
  stripe_payment_intent_id TEXT UNIQUE
    CHECK (stripe_payment_intent_id IS NULL OR length(stripe_payment_intent_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND updated_at >= created_at
  ),
  FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_funding_lots (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  wallet_topup_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL UNIQUE
    CHECK (length(stripe_payment_intent_id) BETWEEN 1 AND 128),
  stripe_charge_id TEXT NOT NULL UNIQUE
    CHECK (length(stripe_charge_id) BETWEEN 1 AND 128),
  original_amount INTEGER NOT NULL CHECK (original_amount BETWEEN 1 AND 100000000),
  available_amount INTEGER NOT NULL CHECK (
    available_amount BETWEEN 0 AND original_amount
  ),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  status TEXT NOT NULL CHECK (status IN (
    'available', 'exhausted', 'refunded', 'disputed'
  )),
  funded_at TEXT NOT NULL CHECK (funded_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND updated_at >= funded_at
  ),
  CHECK (
    (status = 'available' AND available_amount > 0)
    OR (status = 'exhausted' AND available_amount = 0)
    OR status IN ('refunded', 'disputed')
  ),
  FOREIGN KEY (wallet_topup_id)
    REFERENCES wallet_topups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS wallet_funding_lots_available
  ON wallet_funding_lots(organization_id, currency, status, funded_at, id);

CREATE TRIGGER IF NOT EXISTS wallet_funding_lots_reject_identity_update
BEFORE UPDATE OF
  id, wallet_topup_id, organization_id, stripe_payment_intent_id,
  stripe_charge_id, original_amount, currency, funded_at
ON wallet_funding_lots
BEGIN
  SELECT RAISE(ABORT, 'wallet funding lot identity is immutable');
END;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('funding', 'purchase')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  order_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (
    (kind = 'funding' AND stripe_payment_intent_id IS NOT NULL AND order_id IS NULL)
    OR (kind = 'purchase' AND order_id IS NOT NULL AND stripe_payment_intent_id IS NULL)
  ),
  FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  supplier_organization_id TEXT NOT NULL,
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 128),
  product_key TEXT NOT NULL CHECK (length(product_key) BETWEEN 1 AND 128),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 128),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 64),
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 10000000000),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  advisory_quantity INTEGER NOT NULL
    CHECK (advisory_quantity BETWEEN 0 AND 1000000),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '????-??-??T??:??:??*Z'),
  valid_until TEXT NOT NULL CHECK (
    valid_until GLOB '????-??-??T??:??:??*Z'
    AND valid_until > valid_from
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (
      updated_at GLOB '????-??-??T??:??:??*Z'
      AND updated_at >= created_at
    ),
  UNIQUE (supplier_organization_id, sku),
  UNIQUE (id, supplier_organization_id),
  FOREIGN KEY (supplier_organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_items_offer_lookup
  ON catalog_items(product_key, unit, active, valid_until, unit_price, supplier_organization_id);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  buyer_organization_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'revoked')),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '????-??-??T??:??:??*Z'),
  valid_until TEXT NOT NULL CHECK (
    valid_until GLOB '????-??-??T??:??:??*Z'
    AND valid_until > valid_from
  ),
  policy_json TEXT NOT NULL CHECK (
    json_valid(policy_json)
    AND json_type(policy_json) = 'object'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  policy_hash TEXT NOT NULL CHECK (
    length(policy_hash) = 64
    AND policy_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_subject TEXT NOT NULL
    CHECK (length(created_by_subject) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (buyer_organization_id, version),
  UNIQUE (id, buyer_organization_id, version, policy_hash),
  FOREIGN KEY (buyer_organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS mandates_one_active_per_buyer
  ON mandates(buyer_organization_id)
  WHERE state = 'active';

CREATE TRIGGER IF NOT EXISTS mandates_reject_immutable_update
BEFORE UPDATE OF
  id, buyer_organization_id, version, valid_from, valid_until, policy_json,
  schema_version, policy_hash, created_by_subject, created_at
ON mandates
BEGIN
  SELECT RAISE(ABORT, 'mandate versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS mandates_reject_illegal_state_transition
BEFORE UPDATE OF state ON mandates
WHEN NEW.state <> OLD.state
  AND NOT (
    OLD.state = 'active'
    AND NEW.state IN ('superseded', 'revoked')
  )
BEGIN
  SELECT RAISE(ABORT, 'illegal mandate state transition');
END;

CREATE TRIGGER IF NOT EXISTS mandates_reject_delete
BEFORE DELETE ON mandates
BEGIN
  SELECT RAISE(ABORT, 'mandate versions are immutable');
END;

CREATE TABLE IF NOT EXISTS order_denials (
  buyer_organization_id TEXT NOT NULL,
  requester_subject TEXT NOT NULL
    CHECK (length(requester_subject) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  policy_reasons_json TEXT NOT NULL CHECK (
    json_valid(policy_reasons_json)
    AND json_type(policy_reasons_json) = 'array'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??*Z'
  ),
  PRIMARY KEY (
    buyer_organization_id,
    requester_subject,
    idempotency_key
  ),
  FOREIGN KEY (buyer_organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  buyer_organization_id TEXT NOT NULL,
  supplier_organization_id TEXT NOT NULL,
  requester_subject TEXT NOT NULL
    CHECK (length(requester_subject) BETWEEN 1 AND 256),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version >= 1),
  mandate_hash TEXT NOT NULL CHECK (
    length(mandate_hash) = 64
    AND mandate_hash NOT GLOB '*[^0-9a-f]*'
  ),
  catalog_item_id TEXT NOT NULL,
  catalog_item_version INTEGER NOT NULL CHECK (catalog_item_version >= 1),
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 128),
  product_key TEXT NOT NULL CHECK (length(product_key) BETWEEN 1 AND 128),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 128),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 64),
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 10000000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  total INTEGER NOT NULL CHECK (
    total BETWEEN 1 AND 10000000000
    AND unit_price <= 10000000000 / quantity
    AND total = unit_price * quantity
  ),
  delivery_location_id TEXT NOT NULL
    CHECK (length(delivery_location_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN (
    'denied',
    'awaiting_approval',
    'payment_pending',
    'paid',
    'payment_failed',
    'rejected',
    'stale',
    'expired',
    'cancelled'
  )),
  policy_decision TEXT NOT NULL
    CHECK (policy_decision IN ('allow', 'require_approval', 'deny')),
  policy_reasons_json TEXT NOT NULL CHECK (
    json_valid(policy_reasons_json)
    AND json_type(policy_reasons_json) = 'array'
  ),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  approval_expires_at TEXT CHECK (
    approval_expires_at IS NULL
    OR (
      approval_expires_at GLOB '????-??-??T??:??:??*Z'
      AND approval_expires_at > created_at
    )
  ),
  approval_actor_subject TEXT
    CHECK (approval_actor_subject IS NULL OR length(approval_actor_subject) BETWEEN 1 AND 256),
  approval_decided_at TEXT CHECK (
    approval_decided_at IS NULL
    OR approval_decided_at GLOB '????-??-??T??:??:??*Z'
  ),
  approval_reason TEXT CHECK (approval_reason IS NULL OR length(approval_reason) <= 1000),
  stripe_create_started_at TEXT CHECK (
    stripe_create_started_at IS NULL
    OR stripe_create_started_at GLOB '????-??-??T??:??:??*Z'
  ),
  stripe_payment_intent_id TEXT UNIQUE CHECK (
    stripe_payment_intent_id IS NULL
    OR length(stripe_payment_intent_id) BETWEEN 1 AND 128
  ),
  wallet_paid_at TEXT CHECK (
    wallet_paid_at IS NULL OR wallet_paid_at GLOB '????-??-??T??:??:??*Z'
  ),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (
      updated_at GLOB '????-??-??T??:??:??*Z'
      AND updated_at >= created_at
    ),
  UNIQUE (buyer_organization_id, requester_subject, idempotency_key),
  CHECK (buyer_organization_id <> supplier_organization_id),
  CHECK (
    (policy_decision = 'deny' AND status = 'denied')
    OR (
      policy_decision = 'allow'
      AND status IN ('payment_pending', 'paid', 'payment_failed', 'cancelled')
    )
    OR (
      policy_decision = 'require_approval'
      AND status IN (
        'awaiting_approval',
        'payment_pending',
        'paid',
        'payment_failed',
        'rejected',
        'stale',
        'expired',
        'cancelled'
      )
    )
  ),
  CHECK (
    (policy_decision = 'require_approval' AND approval_expires_at IS NOT NULL)
    OR (policy_decision <> 'require_approval' AND approval_expires_at IS NULL)
  ),
  CHECK (
    (approval_actor_subject IS NULL AND approval_decided_at IS NULL)
    OR (approval_actor_subject IS NOT NULL AND approval_decided_at IS NOT NULL)
  ),
  CHECK (approval_reason IS NULL OR approval_actor_subject IS NOT NULL),
  CHECK (
    policy_decision = 'require_approval'
    OR (
      approval_actor_subject IS NULL
      AND approval_decided_at IS NULL
      AND approval_reason IS NULL
    )
  ),
  CHECK (
    policy_decision <> 'require_approval'
    OR status IN ('awaiting_approval', 'stale', 'expired')
    OR approval_actor_subject IS NOT NULL
  ),
  CHECK (
    stripe_create_started_at IS NULL
    OR status IN ('payment_pending', 'paid', 'payment_failed', 'cancelled')
  ),
  CHECK (
    stripe_payment_intent_id IS NULL
    OR (
      stripe_create_started_at IS NOT NULL
      AND status IN ('payment_pending', 'paid', 'payment_failed', 'cancelled')
    )
  ),
  CHECK (
    status NOT IN ('paid', 'payment_failed')
    OR stripe_payment_intent_id IS NOT NULL
    OR (status = 'paid' AND wallet_paid_at IS NOT NULL)
  ),
  CHECK (
    wallet_paid_at IS NULL
    OR (status = 'paid' AND stripe_payment_intent_id IS NULL)
  ),
  FOREIGN KEY (mandate_id, buyer_organization_id, mandate_version, mandate_hash)
    REFERENCES mandates(id, buyer_organization_id, version, policy_hash)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (catalog_item_id, supplier_organization_id)
    REFERENCES catalog_items(id, supplier_organization_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS offer_reservations (
  order_id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL,
  catalog_item_version INTEGER NOT NULL CHECK (catalog_item_version >= 1),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'released', 'settled')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND updated_at >= created_at
  ),
  FOREIGN KEY (order_id) REFERENCES orders(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS offer_reservations_available
  ON offer_reservations(catalog_item_id, status);

CREATE TABLE IF NOT EXISTS wallet_funding_allocations (
  order_id TEXT NOT NULL,
  funding_lot_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (order_id, funding_lot_id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (funding_lot_id) REFERENCES wallet_funding_lots(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER IF NOT EXISTS wallet_funding_allocations_reject_update
BEFORE UPDATE ON wallet_funding_allocations
BEGIN
  SELECT RAISE(ABORT, 'wallet funding allocations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS wallet_funding_allocations_reject_delete
BEFORE DELETE ON wallet_funding_allocations
BEGIN
  SELECT RAISE(ABORT, 'wallet funding allocations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS orders_reject_snapshot_update
BEFORE UPDATE OF
  id, buyer_organization_id, supplier_organization_id, requester_subject,
  mandate_id, mandate_version, mandate_hash, catalog_item_id,
  catalog_item_version, sku, product_key, category, unit, unit_price, quantity,
  currency, total, delivery_location_id, policy_decision, policy_reasons_json,
  idempotency_key, request_hash, approval_expires_at, created_at
ON orders
BEGIN
  SELECT RAISE(ABORT, 'order snapshot is immutable');
END;

CREATE INDEX IF NOT EXISTS orders_buyer_status
  ON orders(buyer_organization_id, status, created_at);

CREATE INDEX IF NOT EXISTS orders_supplier_status
  ON orders(supplier_organization_id, status, created_at);

CREATE INDEX IF NOT EXISTS orders_pending_approvals
  ON orders(buyer_organization_id, approval_expires_at)
  WHERE status = 'awaiting_approval';

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 128),
  object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128),
  received_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (received_at GLOB '????-??-??T??:??:??*Z'),
  processed_at TEXT CHECK (
    processed_at IS NULL
    OR (
      processed_at GLOB '????-??-??T??:??:??*Z'
      AND processed_at >= received_at
    )
  )
) STRICT;

CREATE INDEX IF NOT EXISTS stripe_events_object
  ON stripe_events(object_id, received_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 64),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 128),
  organization_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('buyer_agent', 'supplier_agent', 'human', 'system', 'stripe', 'anonymous')
  ),
  actor_subject TEXT
    CHECK (actor_subject IS NULL OR length(actor_subject) BETWEEN 1 AND 256),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
  ),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS audit_events_organization_time
  ON audit_events(organization_id, created_at, id);

CREATE INDEX IF NOT EXISTS audit_events_aggregate
  ON audit_events(aggregate_type, aggregate_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
