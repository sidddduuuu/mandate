import { redirect } from "next/navigation";
import { cache } from "react";

import { seedDemoDatabase } from "../scripts/seed.ts";
import { getAuth0Client } from "./auth/client.ts";
import {
  actorFromHumanClaims,
  humanClaimsFromSession,
} from "./auth/session.ts";
import { withDatabase } from "./db.ts";

export type DashboardSnapshot = Readonly<{
  organizationName: string;
  displayName: string;
  order: Readonly<{
    id: string;
    requester: string;
    buyerName: string;
    supplierName: string;
    productName: string;
    quantity: number;
    unit: string;
    deliveryLocation: string;
    status: string;
    totalMinor: number;
    currency: string;
    mandateVersion: number;
    policyReasonCodes: readonly string[];
    paymentIntentId: string | null;
  }> | null;
  offers: readonly Readonly<{
    supplierName: string;
    totalMinor: number;
    selected: boolean;
  }>[];
  events: readonly Readonly<{
    id: string;
    time: string;
    title: string;
    actor: string;
    detail: string;
  }>[];
  autonomousLimitMinor: number;
  hardExceptionLimitMinor: number;
  remainingBudgetMinor: number;
  wallet: Readonly<{
    openingBalanceMinor: number;
    spentMinor: number;
    availableMinor: number;
    topups: readonly Readonly<{
      id: string;
      amountMinor: number;
      status: string;
      paymentIntentId: string | null;
      createdAt: string;
    }>[];
  }>;
}>;

function readJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readStringArray(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function eventTitle(eventType: string): string {
  return ({
    "offer.selected": "Lowest eligible offer selected",
    "policy.evaluated": "Purchasing mandate evaluated",
    "order.created": "Order snapshot created",
    "approval.approved": "Purchase approved",
    "approval.rejected": "Purchase rejected",
    "stripe.payment_intent_create_started": "Stripe payment started",
    "stripe.payment_intent_created": "Stripe PaymentIntent created",
    "stripe.payment_intent_confirmed": "Stripe payment confirmed",
    "payment.reconciled": "Stripe webhook reconciled payment",
  } as Record<string, string>)[eventType] ?? eventType.replaceAll(".", " ");
}

function eventDetail(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  if (eventType === "offer.selected") {
    return `${Number(payload.quantity ?? 0)} units · ${(Number(payload.totalMinor ?? 0) / 100).toFixed(2)} ${String(payload.currency ?? "USD")}`;
  }
  if (eventType === "policy.evaluated") {
    const reasons = Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.join(" · ")
      : "";
    return `${String(payload.decision ?? "evaluated")}${reasons ? ` · ${reasons}` : ""}`;
  }
  if (typeof payload.paymentIntentId === "string") {
    return `PaymentIntent …${payload.paymentIntentId.slice(-10)}`;
  }
  if (typeof payload.toStatus === "string") {
    return `${String(payload.fromStatus ?? "")} → ${payload.toStatus}`;
  }
  return "Recorded against the frozen order snapshot";
}

async function identity() {
  const session = await getAuth0Client().getSession();
  if (!session) redirect("/auth/login?returnTo=%2Fdashboard");
  const actor = actorFromHumanClaims(humanClaimsFromSession(session), {
    permission: "approvals:read",
  });
  const displayName =
    typeof session.user.name === "string"
      ? session.user.name
      : typeof session.user.email === "string"
        ? session.user.email
        : session.user.sub;
  return { actor, displayName };
}

export const loadDashboardSnapshot = cache(async (): Promise<DashboardSnapshot> => {
  const { actor, displayName } = await identity();
  return withDatabase(async (database) => {
    if (process.env.NODE_ENV === "development") {
      const catalog = await database.get(
        "SELECT count(*) AS count FROM catalog_items",
      );
      if (Number(catalog?.count) < 9) {
        await seedDemoDatabase(database, {
          buyerAuth0OrgId: actor.organizationId,
          supplierAuth0OrgIds: {
            greenline: "demo_supplier_greenline",
            suncrest: "demo_supplier_suncrest",
            orchard: "demo_supplier_orchard",
          },
        });
      }
    }
    const organization = await database.get(
      "SELECT id, name FROM organizations WHERE auth0_org_id = ?",
      actor.organizationId,
    );
    const order = await database.get(`
      SELECT o.*, buyer.name AS buyer_name, supplier.name AS supplier_name,
        item.display_name AS product_name
      FROM orders o
      JOIN organizations buyer ON buyer.id = o.buyer_organization_id
      JOIN organizations supplier ON supplier.id = o.supplier_organization_id
      JOIN catalog_items item ON item.id = o.catalog_item_id
      WHERE buyer.auth0_org_id = ?
      ORDER BY
        CASE WHEN o.status = 'awaiting_approval'
          AND o.approval_expires_at > ? THEN 0 ELSE 1 END,
        o.created_at DESC, o.id DESC
      LIMIT 1
    `, actor.organizationId, new Date().toISOString());
    const now = new Date().toISOString();
    const offers = order
      ? await database.all(`
          SELECT supplier.name AS supplier_name, item.unit_price
          FROM catalog_items item
          JOIN organizations supplier ON supplier.id = item.supplier_organization_id
          WHERE item.product_key = ? AND item.unit = ? AND item.currency = ?
            AND item.active = 1 AND item.advisory_quantity >= ?
            AND item.valid_from <= ? AND item.valid_until > ?
          ORDER BY item.unit_price, supplier.name
        `, order.product_key, order.unit, order.currency, order.quantity, now, now)
      : [];
    const mandate = order
      ? await database.get(
          "SELECT policy_json FROM mandates WHERE id = ?",
          order.mandate_id,
        )
      : null;
    const policy = readJsonObject(mandate?.policy_json);
    const events = order
      ? await database.all(`
          SELECT id, event_type, actor_type, actor_subject, payload_json,
            created_at
          FROM audit_events
          WHERE aggregate_type = 'order' AND aggregate_id = ?
          ORDER BY created_at, id
        `, order.id)
      : [];
    const wallet = organization
      ? await database.get(
          "SELECT balance FROM wallet_accounts WHERE organization_id = ?",
          organization.id,
        )
      : null;
    const walletTotals = organization
      ? await database.get(
          `SELECT
            COALESCE(SUM(CASE WHEN kind = 'funding' THEN amount ELSE 0 END), 0)
              AS funded,
            COALESCE(SUM(CASE WHEN kind = 'purchase' THEN amount ELSE 0 END), 0)
              AS spent
          FROM wallet_transactions WHERE organization_id = ?`,
          organization.id,
        )
      : null;
    const topups = organization
      ? await database.all(`
          SELECT id, amount, status, stripe_payment_intent_id, created_at
          FROM wallet_topups
          WHERE organization_id = ?
          ORDER BY created_at DESC
          LIMIT 10
        `, organization.id)
      : [];
    const fundedMinor = Number(walletTotals?.funded ?? 0);
    const spentMinor = Number(walletTotals?.spent ?? 0);

    return Object.freeze({
      organizationName: String(organization?.name ?? "Business account"),
      displayName,
      order: order
        ? Object.freeze({
            id: String(order.id),
            requester: String(order.requester_subject),
            buyerName: String(order.buyer_name),
            supplierName: String(order.supplier_name),
            productName: String(order.product_name).split(" — ")[0],
            quantity: Number(order.quantity),
            unit: String(order.unit),
            deliveryLocation: String(order.delivery_location_id),
            status: String(order.status),
            totalMinor: Number(order.total),
            currency: String(order.currency),
            mandateVersion: Number(order.mandate_version),
            policyReasonCodes: Object.freeze(readStringArray(order.policy_reasons_json)),
            paymentIntentId: typeof order.stripe_payment_intent_id === "string"
              ? order.stripe_payment_intent_id
              : null,
          })
        : null,
      offers: Object.freeze(offers.map((offer) => Object.freeze({
        supplierName: String(offer.supplier_name),
        totalMinor: Number(offer.unit_price) * Number(order?.quantity ?? 0),
        selected: String(offer.supplier_name) === String(order?.supplier_name),
      }))),
      events: Object.freeze(events.map((event) => {
        const payload = readJsonObject(event.payload_json);
        const createdAt = new Date(String(event.created_at));
        return Object.freeze({
          id: String(event.id),
          time: Number.isNaN(createdAt.getTime())
            ? "—"
            : createdAt.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              }),
          title: eventTitle(String(event.event_type)),
          actor: event.actor_type === "human"
            ? "Auth0 human"
            : event.actor_type === "buyer_agent"
              ? String(event.actor_subject ?? "inventory-agent-prod")
              : event.actor_type === "stripe"
                ? "Stripe"
                : "Mandate",
          detail: eventDetail(String(event.event_type), payload),
        });
      })),
      autonomousLimitMinor: Number(policy.autonomousOrderLimitMinor ?? 25_000),
      hardExceptionLimitMinor: Number(policy.hardExceptionLimitMinor ?? 100_000),
      remainingBudgetMinor: events.reduce((remaining, event) => {
        if (event.event_type !== "policy.evaluated") return remaining;
        const value = readJsonObject(event.payload_json).remainingBudgetMinor;
        return typeof value === "number" ? value : remaining;
      }, 500_000),
      wallet: Object.freeze({
        openingBalanceMinor: fundedMinor,
        spentMinor,
        availableMinor: Number(wallet?.balance ?? 0),
        topups: Object.freeze(topups.map((topup) => Object.freeze({
          id: String(topup.id),
          amountMinor: Number(topup.amount),
          status: String(topup.status),
          paymentIntentId: typeof topup.stripe_payment_intent_id === "string"
            ? topup.stripe_payment_intent_id
            : null,
          createdAt: String(topup.created_at),
        }))),
      }),
    });
  });
});
