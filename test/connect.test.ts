import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

import { AuthError, type ActorContext } from "../src/auth/context.ts";
import { initializeDatabase } from "../src/db.ts";
import {
  createSupplierOnboardingSession,
  getSupplierPaymentStatus,
  reconcileSupplierAccountEvent,
  reconcileSupplierPaymentAccount,
  supplierPaymentState,
  type ConnectClient,
} from "../src/payments/connect.ts";
import {
  supplierAccountEvent,
  verifyStripeWebhook,
} from "../src/webhooks/stripe.ts";

const now = new Date("2026-07-30T12:00:00.000Z");

function actor(organizationId: string): ActorContext {
  return Object.freeze({
    organizationId,
    actorType: "human",
    contactEmail: "supplier@test.com",
    scopes: Object.freeze(["orders:read"]),
    subject: `${organizationId}@test`,
  });
}

function account(
  status: "active" | "pending" | "restricted" = "pending",
  requirements: Stripe.V2.Core.Account.Requirements["entries"] = [],
): Stripe.V2.Core.Account {
  return {
    id: "acct_supplier",
    object: "v2.core.account",
    applied_configurations: ["recipient"],
    created: now.toISOString(),
    livemode: false,
    dashboard: "express",
    configuration: {
      recipient: {
        applied: true,
        capabilities: {
          stripe_balance: {
            stripe_transfers: { status, status_details: [] },
          },
        },
      },
    },
    requirements: { entries: requirements },
  };
}

function blockingRequirement(): Stripe.V2.Core.Account.Requirements.Entry {
  return {
    awaiting_action_from: "user",
    description: "Provide payout details",
    errors: [],
    impact: {
      restricts_capabilities: [{
        capability: "stripe_balance.stripe_transfers",
        configuration: "recipient",
        deadline: { status: "currently_due" },
      }],
    },
    minimum_deadline: { status: "currently_due" },
    requested_reasons: [{ code: "routine_onboarding" }],
  };
}

test("supplier onboarding creates one Accounts v2 recipient and exposes no account ID", async () => {
  const database = initializeDatabase(":memory:");
  await database.run(`
    INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
    VALUES ('supplier', 'org_supplier', 'Supplier', 'supplier', ?),
      ('supplier-2', 'org_supplier_2', 'Supplier 2', 'supplier', ?),
      ('buyer', 'org_buyer', 'Buyer', 'buyer', ?)
  `, now.toISOString(), now.toISOString(), now.toISOString());
  let accountCreates = 0;
  let sessionCreates = 0;
  const client: ConnectClient = {
    accounts: {
      create: async (params, options) => {
        accountCreates += 1;
        assert.equal(params.contact_email, "supplier@test.com");
        assert.equal(params.identity?.country, "US");
        assert.equal(params.dashboard, "express");
        assert.equal(params.defaults?.responsibilities?.fees_collector, "application");
        assert.equal(params.defaults?.responsibilities?.losses_collector, "application");
        assert.equal(
          params.configuration?.recipient?.capabilities?.stripe_balance
            ?.stripe_transfers?.requested,
          true,
        );
        assert.equal(options.idempotencyKey, "supplier:supplier:connect-account");
        return account();
      },
      retrieve: async () => account(),
    },
    accountSessions: {
      create: async (params) => {
        sessionCreates += 1;
        assert.equal(params.account, "acct_supplier");
        assert.equal(params.components.account_onboarding?.enabled, true);
        assert.equal(params.components.notification_banner?.enabled, true);
        return {
          object: "account_session",
          account: "acct_supplier",
          client_secret: `secret_${sessionCreates}`,
          components: {},
          expires_at: 1,
          livemode: false,
        } as Stripe.AccountSession;
      },
    },
  };
  const supplier = actor("org_supplier");
  assert.equal(
    (await createSupplierOnboardingSession(
      database,
      supplier,
      "request-1",
      client,
      now,
    )).clientSecret,
    "secret_1",
  );
  await createSupplierOnboardingSession(
    database,
    supplier,
    "request-2",
    client,
    now,
  );
  assert.equal(accountCreates, 1);
  assert.equal(sessionCreates, 2);
  assert.deepEqual(await getSupplierPaymentStatus(database, supplier), {
    onboardingStatus: "pending",
    requirementsStatus: "clear",
    stripeTransfersStatus: "pending",
    payoutReady: false,
  });
  await assert.rejects(
    getSupplierPaymentStatus(database, actor("org_buyer")),
    (error: unknown) => error instanceof AuthError && error.code === "forbidden",
  );
  assert.throws(() => database.prepare(`
    INSERT INTO supplier_payment_accounts (
      supplier_organization_id, stripe_account_id, onboarding_status,
      requirements_status, stripe_transfers_status, payout_ready,
      created_at, updated_at
    ) VALUES ('supplier-2', 'acct_supplier', 'pending', 'clear', 'pending', 0, ?, ?)
  `).run(now.toISOString(), now.toISOString()));
  await database.close();
});

test("Stripe account events are idempotent, ordered, and fail closed on requirements", async () => {
  const database = initializeDatabase(":memory:");
  await database.run(`
    INSERT INTO organizations (id, auth0_org_id, name, kind, created_at)
    VALUES ('supplier', 'org_supplier', 'Supplier', 'supplier', ?)
  `, now.toISOString());
  await database.run(`
    INSERT INTO supplier_payment_accounts (
      supplier_organization_id, stripe_account_id, onboarding_status,
      requirements_status, stripe_transfers_status, payout_ready,
      created_at, updated_at
    ) VALUES ('supplier', 'acct_supplier', 'pending', 'clear', 'pending', 0, ?, ?)
  `, now.toISOString(), now.toISOString());
  const active = account("active");
  assert.equal(supplierPaymentState(active).payoutReady, true);
  assert.equal(
    supplierPaymentState(account("active", [blockingRequirement()])).payoutReady,
    false,
  );
  const current = {
    id: "evt_account_current",
    type: "v2.core.account[configuration.recipient].capability_status_updated",
    created: "2026-07-30T12:05:00.000Z",
  };
  const reader: ConnectClient = {
    accounts: {
      create: async () => active,
      retrieve: async (id, params) => {
        assert.equal(id, "acct_supplier");
        assert.deepEqual(params.include, [
          "configuration.recipient",
          "requirements",
        ]);
        return active;
      },
    },
    accountSessions: { create: async () => { throw new Error("unused"); } },
  };
  assert.equal(await reconcileSupplierAccountEvent(
    database,
    { ...current, accountId: "acct_supplier" },
    "current",
    reader,
    now,
  ), "processed");
  assert.equal(
    await reconcileSupplierPaymentAccount(
      database,
      current,
      account("restricted"),
      "duplicate",
      now,
    ),
    "duplicate",
  );
  assert.equal(
    await reconcileSupplierPaymentAccount(database, {
      ...current,
      id: "evt_account_old",
      created: "2026-07-30T12:04:00.000Z",
    }, account("restricted"), "old", now),
    "ignored",
  );
  assert.equal((await database.get(`
    SELECT payout_ready FROM supplier_payment_accounts
    WHERE supplier_organization_id = 'supplier'
  `))?.payout_ready, 1);
  assert.equal(
    await reconcileSupplierPaymentAccount(database, {
      ...current,
      id: "evt_account_restricted",
      created: "2026-07-30T12:06:00.000Z",
    }, account("restricted"), "restricted", now),
    "processed",
  );
  assert.equal((await database.get(`
    SELECT payout_ready FROM supplier_payment_accounts
    WHERE supplier_organization_id = 'supplier'
  `))?.payout_ready, 0);
  await database.close();
});

test("signed Accounts v2 event notifications use the v2 verifier", async (context) => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_demo";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_demo";
  context.after(() => {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  });
  const payload = JSON.stringify({
    id: "evt_v2_account",
    object: "v2.core.event",
    type: "v2.core.account[requirements].updated",
    created: "2026-07-30T12:00:00.000Z",
    livemode: false,
    related_object: {
      id: "acct_supplier",
      type: "v2.core.account",
      url: "/v2/core/accounts/acct_supplier",
    },
  });
  const signature = new Stripe("sk_test_demo").webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_demo",
    timestamp: Math.floor(Date.now() / 1_000),
  });
  const event = supplierAccountEvent(await verifyStripeWebhook(new Request(
    "http://localhost/api/webhooks/stripe",
    {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    },
  )));
  assert.equal(event?.accountId, "acct_supplier");
  assert.equal(event?.type, "v2.core.account[requirements].updated");
});
