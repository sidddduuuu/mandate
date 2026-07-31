/**
 * Live Stripe test-mode proof against Mandate's payment adapter + webhook verifier.
 * Requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (e.g. from `stripe listen --print-secret`).
 * Auth uses AUTH_TEST_MODE HMAC actors (Auth0 tenant credentials are checked separately).
 */
import { randomUUID } from "crypto";
import { loadEnvFile } from "./load-env";
import { resetDbForTests, closeDb } from "../src/db";
import { resetConfigCache, getConfig } from "../src/lib/config";
import { seedRegisteredSku } from "../src/catalog/catalog";
import { createMandateVersion } from "../src/procurement/mandates";
import { createOrder, decideApproval, handleStripeWebhook } from "../src/procurement/orders";
import { createStripeAdapter } from "../src/payments/stripe";
import { newId, nowIso } from "../src/lib/ids";
import type { ActorContext } from "../src/auth/context";
import Stripe from "stripe";

loadEnvFile();
process.env.AUTH_TEST_MODE = "1";
process.env.DATABASE_PATH = "./data/live-stripe-check.db";
resetConfigCache();

const cfg = getConfig();
const key = cfg.STRIPE_SECRET_KEY ?? "";
const isTestKey =
  key.includes("_test_") || key.startsWith("sk_test") || key.startsWith("rk_test") || key.startsWith("rkcs_test");
if (!isTestKey) {
  console.error("REFUSE: STRIPE_SECRET_KEY is missing or not a test/sandbox key");
  process.exit(2);
}
if (!cfg.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
  console.error("REFUSE: STRIPE_WEBHOOK_SECRET missing (run: stripe listen --print-secret)");
  process.exit(2);
}

const db = resetDbForTests("./data/live-stripe-check.db");
const stripe = createStripeAdapter();
const stripeRaw = new Stripe(cfg.STRIPE_SECRET_KEY!);

const buyerOrg = newId("org");
const supplierA = newId("org");
const supplierB = newId("org");
const now = nowIso();
const from = new Date(Date.now() - 60_000).toISOString();
const until = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

db.prepare(
  `INSERT INTO organizations (id, auth0_org_id, name, kind, stripe_customer_id, created_at)
   VALUES (?, 'org_buyer', 'Restaurant', 'buyer', NULL, ?),
          (?, 'org_supplier_a', 'Supplier A', 'supplier', NULL, ?),
          (?, 'org_supplier_b', 'Supplier B', 'supplier', NULL, ?)`,
).run(buyerOrg, now, supplierA, now, supplierB, now);

seedRegisteredSku(db, {
  supplierOrgId: supplierA,
  sku: "AVO-CASE-48",
  productKey: "avocado",
  category: "produce",
  unit: "case",
  unitPriceMinor: 4200,
  currency: "USD",
  advisoryQuantity: 50,
  validFrom: from,
  validUntil: until,
  displayName: "Avocados A",
});
seedRegisteredSku(db, {
  supplierOrgId: supplierB,
  sku: "AVO-CASE-48",
  productKey: "avocado",
  category: "produce",
  unit: "case",
  unitPriceMinor: 3900,
  currency: "USD",
  advisoryQuantity: 50,
  validFrom: from,
  validUntil: until,
  displayName: "Avocados B",
});

const human: ActorContext = {
  actorType: "human",
  subject: "human-approver",
  organizationId: buyerOrg,
  auth0OrgId: "org_buyer",
  scopes: new Set(),
  permissions: new Set(["mandates:write", "approvals:read", "approvals:decide", "orders:read"]),
};

const buyer: ActorContext = {
  actorType: "agent",
  subject: "buyer-agent",
  organizationId: buyerOrg,
  auth0OrgId: "org_buyer",
  scopes: new Set(["orders:create", "orders:read", "offers:read"]),
  permissions: new Set(),
};

createMandateVersion(
  db,
  human,
  {
    currency: "USD",
    autonomous_order_limit_minor: 5000,
    hard_exception_limit_minor: 50_000,
    budget_window_start: from,
    budget_window_end: until,
    budget_limit_minor: 100_000,
    allowed_supplier_org_ids: [supplierA, supplierB],
    allowed_categories: ["produce"],
    allowed_delivery_location_ids: ["kitchen-1"],
    valid_from: from,
    valid_until: until,
  },
  "live-stripe-mandate",
);

async function main(): Promise<void> {
  const { order, httpStatus } = await createOrder(
    db,
    buyer,
    {
      product_key: "avocado",
      unit: "case",
      quantity: 2,
      delivery_location_id: "kitchen-1",
    },
    randomUUID(),
    "live-stripe-order",
    stripe,
  );

  console.log("order_created", {
    httpStatus,
    status: order.status,
    total: order.total_minor,
    pi: order.stripe_payment_intent_id,
  });

  if (httpStatus !== 202 || order.status !== "awaiting_approval") {
    throw new Error("expected awaiting_approval before Stripe contact");
  }
  if (order.stripe_payment_intent_id) {
    throw new Error("PaymentIntent must not exist before approval");
  }

  // Hard deny must not call Stripe
  const denyStart = await stripeRaw.paymentIntents.list({ limit: 3 });
  const denyBaseline = new Set(denyStart.data.map((p) => p.id));

  const denied = await createOrder(
    db,
    buyer,
    {
      product_key: "avocado",
      unit: "case",
      quantity: 100, // above hard exception (50_000) at 3900 => 390_000
      delivery_location_id: "kitchen-1",
    },
    randomUUID(),
    "live-stripe-deny",
    stripe,
  );
  if (denied.order.status !== "denied" || denied.order.stripe_payment_intent_id) {
    throw new Error("hard deny should not create a PaymentIntent");
  }
  const denyAfter = await stripeRaw.paymentIntents.list({ limit: 3 });
  const newAfterDeny = denyAfter.data.filter((p) => !denyBaseline.has(p.id));
  if (newAfterDeny.length > 0) {
    throw new Error(`hard deny created Stripe PaymentIntent(s): ${newAfterDeny.map((p) => p.id).join(",")}`);
  }
  console.log("hard_deny_no_stripe", { status: denied.order.status });

  const approved = await decideApproval(
    db,
    human,
    order.id,
    { decision: "approve", reason: "Live Stripe check" },
    "live-stripe-approve",
    stripe,
  );
  console.log("approved", {
    status: approved.status,
    pi: approved.stripe_payment_intent_id,
    total: approved.total_minor,
  });

  if (!approved.stripe_payment_intent_id?.startsWith("pi_")) {
    throw new Error("expected real Stripe PaymentIntent id");
  }

  const remote = await stripeRaw.paymentIntents.retrieve(approved.stripe_payment_intent_id);
  console.log("remote_pi", {
    id: remote.id,
    status: remote.status,
    amount: remote.amount,
    currency: remote.currency,
    livemode: remote.livemode,
    order_id: remote.metadata.order_id,
  });

  if (remote.livemode) throw new Error("REFUSE: livemode PaymentIntent");
  if (remote.metadata.order_id !== approved.id) throw new Error("order_id metadata mismatch");
  if (remote.amount !== approved.total_minor) throw new Error("amount mismatch");

  // Build a signed webhook payload the same way Stripe CLI / Dashboard would
  const eventPayload = {
    id: `evt_live_check_${randomUUID()}`,
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.succeeded",
    livemode: false,
    data: {
      object: {
        id: remote.id,
        object: "payment_intent",
        amount: remote.amount,
        currency: remote.currency,
        status: "succeeded",
        metadata: remote.metadata,
      },
    },
  };
  const rawBody = JSON.stringify(eventPayload);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: cfg.STRIPE_WEBHOOK_SECRET!,
  });
  const verified = stripe.constructEvent(rawBody, header);
  console.log("webhook_signature_ok", { type: verified.type, id: verified.id });

  // Reject garbage signature
  let rejected = false;
  try {
    stripe.constructEvent(rawBody, "t=1,v1=deadbeef");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("invalid signature should fail");
  console.log("webhook_bad_signature_rejected", true);

  handleStripeWebhook(
    db,
    {
      id: verified.id,
      type: verified.type,
      data: {
        object: {
          id: remote.id,
          amount: remote.amount,
          currency: remote.currency,
          metadata: { order_id: approved.id },
        },
      },
    },
    "live-stripe-webhook",
  );

  const paid = db.prepare(`SELECT status, stripe_payment_intent_id FROM orders WHERE id = ?`).get(
    approved.id,
  ) as { status: string; stripe_payment_intent_id: string };
  console.log("final", paid);

  // Replay webhook — no duplicate transition
  const replay = handleStripeWebhook(
    db,
    {
      id: verified.id,
      type: verified.type,
      data: {
        object: {
          id: remote.id,
          amount: remote.amount,
          currency: remote.currency,
          metadata: { order_id: approved.id },
        },
      },
    },
    "live-stripe-webhook-replay",
  );
  console.log("webhook_replay", replay);

  // Synthetic event for unrelated PI must not mark this order differently
  const beforeUnrelated = paid.status;
  handleStripeWebhook(
    db,
    {
      id: `evt_unrelated_${randomUUID()}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_unrelated_should_not_match",
          amount: remote.amount,
          currency: remote.currency,
          metadata: { order_id: "order_does_not_exist" },
        },
      },
    },
    "live-stripe-unrelated",
  );
  const afterUnrelated = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(approved.id) as {
    status: string;
  };
  if (afterUnrelated.status !== beforeUnrelated) {
    throw new Error("unrelated webhook changed order status");
  }
  console.log("unrelated_webhook_ignored", true);

  if (paid.status !== "paid") throw new Error(`expected paid, got ${paid.status}`);
  console.log("LIVE_STRIPE_CHECK_PASSED");
  closeDb();
}

main().catch((err) => {
  console.error("LIVE_STRIPE_CHECK_FAILED", err);
  closeDb();
  process.exit(1);
});
