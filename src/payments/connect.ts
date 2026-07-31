import Stripe from "stripe";
import { z } from "zod";

import { AuthError, type ActorContext } from "../auth/context.ts";
import { type Database, withImmediateTransaction } from "../db.ts";
import { ApiError } from "../http.ts";

const accountSchema = z.object({
  id: z.string().min(1).max(128),
  object: z.literal("v2.core.account"),
  livemode: z.boolean(),
  closed: z.boolean().optional(),
  configuration: z.object({
    recipient: z.object({
      capabilities: z.object({
        stripe_balance: z.object({
          stripe_transfers: z.object({
            status: z.enum(["active", "pending", "restricted", "unsupported"]),
          }).passthrough().optional(),
        }).passthrough().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  requirements: z.object({
    entries: z.array(z.object({
      awaiting_action_from: z.enum(["stripe", "user"]),
      impact: z.object({
        restricts_capabilities: z.array(z.object({
          capability: z.string(),
          configuration: z.string(),
          deadline: z.object({
            status: z.enum(["currently_due", "eventually_due", "past_due"]),
          }),
        })).optional(),
      }),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

// ponytail: US-only MVP; store supplier country when cross-border onboarding is added.
const CONNECTED_ACCOUNT_COUNTRY = "US";

type Account = z.output<typeof accountSchema>;

export type ConnectClient = Readonly<{
  accounts: Readonly<{
    create(
      params: Stripe.V2.Core.AccountCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<unknown>;
    retrieve(
      id: string,
      params: Stripe.V2.Core.AccountRetrieveParams,
    ): Promise<unknown>;
  }>;
  accountSessions: Readonly<{
    create(
      params: Stripe.AccountSessionCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<Stripe.AccountSession>;
  }>;
}>;

export type SupplierPaymentStatus = Readonly<{
  onboardingStatus: string;
  requirementsStatus: string;
  stripeTransfersStatus: string;
  payoutReady: boolean;
}>;

type Supplier = Readonly<{ id: string; name: string; contactEmail?: string }>;

function unavailable(): ApiError {
  return new ApiError(
    503,
    "CONNECT_UNAVAILABLE",
    "Supplier payout onboarding is unavailable",
  );
}

function stripeConnectClient(): ConnectClient {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret || !/^[sr]k_test_/.test(secret)) throw unavailable();
  const stripe = new Stripe(secret);
  return Object.freeze({
    accounts: stripe.v2.core.accounts,
    accountSessions: stripe.accountSessions,
  });
}

async function requireSupplier(
  database: Database,
  actor: ActorContext,
): Promise<Supplier> {
  const authorized = actor.actorType === "supplier_agent"
    ? actor.scopes.includes("catalog:write")
    : actor.actorType === "human"
      && (actor.scopes.includes("openid") || actor.scopes.includes("orders:read"));
  if (!authorized) throw new AuthError("forbidden");
  const row = await database.get(
    "SELECT id, name, kind FROM organizations WHERE auth0_org_id = ?",
    actor.organizationId,
  );
  if (typeof row?.id !== "string" || typeof row.name !== "string" || row.kind !== "supplier") {
    throw new AuthError("forbidden");
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    ...(actor.contactEmail ? { contactEmail: actor.contactEmail } : {}),
  });
}

function transferStatus(account: Account): string {
  return account.configuration?.recipient?.capabilities?.stripe_balance
    ?.stripe_transfers?.status ?? "inactive";
}

function blocksTransfers(account: Account): boolean {
  return (account.requirements?.entries ?? []).some((entry) =>
    entry.impact.restricts_capabilities?.some((impact) =>
      impact.configuration === "recipient"
      && impact.capability === "stripe_balance.stripe_transfers"
      && impact.deadline.status !== "eventually_due"
    )
  );
}

export function supplierPaymentState(input: unknown): SupplierPaymentStatus {
  const account = parseSupplierAccount(input);
  const transfers = transferStatus(account);
  const requirements = account.requirements?.entries ?? [];
  const requirementsStatus = requirements.some(({ awaiting_action_from }) =>
    awaiting_action_from === "user"
  )
    ? "due"
    : requirements.length
      ? "pending"
      : "clear";
  const payoutReady = !account.livemode
    && !account.closed
    && transfers === "active"
    && !blocksTransfers(account);
  const onboardingStatus = account.closed
    || ["restricted", "unsupported"].includes(transfers)
    ? "restricted"
    : payoutReady
      ? "complete"
      : requirementsStatus === "due"
        ? "requirements_due"
        : "pending";
  return Object.freeze({
    onboardingStatus,
    requirementsStatus,
    stripeTransfersStatus: transfers,
    payoutReady,
  });
}

export function parseSupplierAccount(input: unknown): Account {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) throw new Error("Stripe returned an invalid connected account");
  return parsed.data;
}

async function paymentAccount(
  database: Database,
  supplierId: string,
): Promise<Record<string, unknown> | undefined> {
  return database.get(`
    SELECT stripe_account_id, onboarding_status, requirements_status,
      stripe_transfers_status, payout_ready
    FROM supplier_payment_accounts WHERE supplier_organization_id = ?
  `, supplierId);
}

function publicStatus(row: Record<string, unknown>): SupplierPaymentStatus {
  return Object.freeze({
    onboardingStatus: String(row.onboarding_status),
    requirementsStatus: String(row.requirements_status),
    stripeTransfersStatus: String(row.stripe_transfers_status),
    payoutReady: row.payout_ready === 1,
  });
}

export async function getSupplierPaymentStatus(
  database: Database,
  actor: ActorContext,
): Promise<SupplierPaymentStatus> {
  const supplier = await requireSupplier(database, actor);
  const row = await paymentAccount(database, supplier.id);
  return row
    ? publicStatus(row)
    : Object.freeze({
        onboardingStatus: "not_started",
        requirementsStatus: "unknown",
        stripeTransfersStatus: "inactive",
        payoutReady: false,
      });
}

async function persistAccount(
  database: Database,
  supplier: Supplier,
  account: Account,
  now: string,
): Promise<void> {
  const state = supplierPaymentState(account);
  await withImmediateTransaction(database, async (tx) => {
    await tx.run(`
      INSERT INTO supplier_payment_accounts (
        supplier_organization_id, stripe_account_id, onboarding_status,
        requirements_status, stripe_transfers_status, payout_ready,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(supplier_organization_id) DO NOTHING
    `,
      supplier.id,
      account.id,
      state.onboardingStatus,
      state.requirementsStatus,
      state.stripeTransfersStatus,
      state.payoutReady ? 1 : 0,
      now,
      now,
    );
    const stored = await paymentAccount(tx, supplier.id);
    if (stored?.stripe_account_id !== account.id) {
      throw new Error("Supplier is linked to a different Stripe account");
    }
  });
}

async function createAccount(
  supplier: Supplier,
  client: ConnectClient,
): Promise<Account> {
  if (!supplier.contactEmail) {
    throw new ApiError(
      422,
      "SUPPLIER_EMAIL_REQUIRED",
      "Supplier contact email is required",
    );
  }
  const account = parseSupplierAccount(await client.accounts.create({
    contact_email: supplier.contactEmail,
    display_name: supplier.name,
    identity: { country: CONNECTED_ACCOUNT_COUNTRY },
    dashboard: "express",
    defaults: {
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application",
      },
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: { stripe_transfers: { requested: true } },
        },
      },
    },
    include: ["configuration.recipient", "requirements"],
    metadata: { supplier_organization_id: supplier.id },
  }, { idempotencyKey: `supplier:${supplier.id}:connect-account` }));
  if (!account.id || account.livemode || account.object !== "v2.core.account") {
    throw new Error("Stripe returned an invalid connected account");
  }
  return account;
}

export async function createSupplierOnboardingSession(
  database: Database,
  actor: ActorContext,
  requestId: string,
  client = stripeConnectClient(),
  now = new Date(),
): Promise<Readonly<{ clientSecret: string; status: SupplierPaymentStatus }>> {
  const supplier = await requireSupplier(database, actor);
  let row = await paymentAccount(database, supplier.id);
  if (!row) {
    await persistAccount(
      database,
      supplier,
      await createAccount(supplier, client),
      now.toISOString(),
    );
    row = await paymentAccount(database, supplier.id);
  }
  if (!row || typeof row.stripe_account_id !== "string") throw unavailable();
  let session: Stripe.AccountSession;
  try {
    session = await client.accountSessions.create({
      account: row.stripe_account_id,
      components: {
        account_onboarding: { enabled: true },
        account_management: { enabled: true },
        notification_banner: { enabled: true },
      },
    }, { idempotencyKey: `supplier:${supplier.id}:onboarding:${requestId}` });
  } catch {
    throw unavailable();
  }
  if (
    session.account !== row.stripe_account_id
    || session.livemode
    || !session.client_secret
  ) throw new Error("Stripe returned an invalid Account Session");
  return Object.freeze({
    clientSecret: session.client_secret,
    status: publicStatus(row),
  });
}

export async function reconcileSupplierPaymentAccount(
  database: Database,
  event: Readonly<{ id: string; type: string; created: string }>,
  accountInput: unknown,
  requestId: string,
  now = new Date(),
): Promise<"processed" | "duplicate" | "ignored"> {
  const account = parseSupplierAccount(accountInput);
  const state = supplierPaymentState(account);
  const processedAt = now.toISOString();
  return withImmediateTransaction(database, async (tx) => {
    const inserted = await tx.get(`
      INSERT INTO stripe_events (event_id, type, object_id, received_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
      RETURNING event_id
    `, event.id, event.type, account.id, processedAt);
    if (!inserted) return "duplicate";
    const updated = await tx.run(`
      UPDATE supplier_payment_accounts SET
        onboarding_status = ?, requirements_status = ?,
        stripe_transfers_status = ?, payout_ready = ?,
        last_stripe_event_created_at = ?, updated_at = ?
      WHERE stripe_account_id = ?
        AND (
          last_stripe_event_created_at IS NULL
          OR last_stripe_event_created_at <= ?
        )
    `,
      state.onboardingStatus,
      state.requirementsStatus,
      state.stripeTransfersStatus,
      state.payoutReady ? 1 : 0,
      event.created,
      processedAt,
      account.id,
      event.created,
    );
    await tx.run(
      "UPDATE stripe_events SET processed_at = ? WHERE event_id = ?",
      processedAt,
      event.id,
    );
    if (updated.changes !== 1) return "ignored";
    const supplier = await tx.get(`
      SELECT supplier_organization_id FROM supplier_payment_accounts
      WHERE stripe_account_id = ?
    `, account.id);
    await tx.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('supplier_payment_account', ?, ?, 'supplier.payout_readiness_updated',
        'stripe', ?, ?, ?, ?)
    `,
      account.id,
      supplier?.supplier_organization_id ?? null,
      event.id,
      requestId,
      JSON.stringify({
        stripeEventType: event.type,
        onboardingStatus: state.onboardingStatus,
        requirementsStatus: state.requirementsStatus,
        stripeTransfersStatus: state.stripeTransfersStatus,
        payoutReady: state.payoutReady,
      }),
      processedAt,
    );
    return "processed";
  });
}

export async function reconcileSupplierAccountEvent(
  database: Database,
  event: Readonly<{
    id: string;
    type: string;
    created: string;
    accountId: string;
  }>,
  requestId: string,
  client = stripeConnectClient(),
  now = new Date(),
): Promise<"processed" | "duplicate" | "ignored"> {
  const account = await client.accounts.retrieve(event.accountId, {
    include: ["configuration.recipient", "requirements"],
  });
  return reconcileSupplierPaymentAccount(
    database,
    event,
    account,
    requestId,
    now,
  );
}
