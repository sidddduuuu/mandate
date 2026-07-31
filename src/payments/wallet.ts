import { randomUUID } from "node:crypto";

import type { ActorContext } from "../auth/context.ts";
import {
  type Database,
  withImmediateTransaction,
} from "../db.ts";
import { ApiError } from "../http.ts";

async function buyerId(database: Database, actor: ActorContext): Promise<string> {
  const row = await database.get(
    "SELECT id FROM organizations WHERE auth0_org_id = ? AND kind = 'buyer'",
    actor.organizationId,
  );
  if (typeof row?.id !== "string") {
    throw new ApiError(403, "FORBIDDEN", "Unauthorized");
  }
  return row.id;
}

export async function getWallet(database: Database, actor: ActorContext) {
  const organizationId = await buyerId(database, actor);
  const wallet = await database.get(
    "SELECT balance, currency, updated_at FROM wallet_accounts WHERE organization_id = ?",
    organizationId,
  );
  const topups = await database.all(`
    SELECT id, amount, currency, status, stripe_payment_intent_id, created_at
    FROM wallet_topups
    WHERE organization_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `, organizationId);
  return Object.freeze({
    balanceMinor: Number(wallet?.balance ?? 0),
    currency: String(wallet?.currency ?? "USD"),
    updatedAt: typeof wallet?.updated_at === "string" ? wallet.updated_at : null,
    topups: Object.freeze(topups.map((topup) => Object.freeze({
      id: String(topup.id),
      amountMinor: Number(topup.amount),
      currency: String(topup.currency),
      status: String(topup.status),
      paymentIntentId: typeof topup.stripe_payment_intent_id === "string"
        ? topup.stripe_payment_intent_id
        : null,
      createdAt: String(topup.created_at),
    }))),
  });
}

export async function createWalletTopUp(
  database: Database,
  actor: ActorContext,
  amountMinor: number,
  requestId: string,
  now = new Date(),
) {
  const organizationId = await buyerId(database, actor);
  const id = randomUUID();
  const createdAt = now.toISOString();
  await withImmediateTransaction(database, async (tx) => {
    await tx.run(`
      INSERT INTO wallet_accounts (
        organization_id, currency, balance, created_at, updated_at
      ) VALUES (?, 'USD', 0, ?, ?)
      ON CONFLICT(organization_id) DO NOTHING
    `, organizationId, createdAt, createdAt);
    await tx.run(`
      INSERT INTO wallet_topups (
        id, organization_id, amount, currency, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'USD', 'pending', ?, ?)
    `, id, organizationId, amountMinor, createdAt, createdAt);
    await tx.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('wallet_topup', ?, ?, 'wallet.topup_requested', 'human', ?, ?, ?, ?)
    `, id, organizationId, actor.subject, requestId, JSON.stringify({
      amountMinor,
      currency: "USD",
    }), createdAt);
  });
  return Object.freeze({ id, organizationId, amountMinor, currency: "USD" });
}

export async function settleOrderFromWallet(
  database: Database,
  orderId: string,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const createdAt = now.toISOString();
  await withImmediateTransaction(database, async (tx) => {
    const order = await tx.get(`
      SELECT id, buyer_organization_id, total, currency, status
      FROM orders WHERE id = ? FOR UPDATE
    `, orderId);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
    const prior = await tx.get(
      "SELECT id FROM wallet_transactions WHERE order_id = ?",
      orderId,
    );
    if (prior) return;
    if (order.status !== "payment_pending") {
      throw new ApiError(409, "PAYMENT_NOT_READY", "Order is not ready for payment");
    }
    const wallet = await tx.get(`
      SELECT balance, currency FROM wallet_accounts
      WHERE organization_id = ? FOR UPDATE
    `, order.buyer_organization_id);
    const total = Number(order.total);
    if (
      !wallet
      || wallet.currency !== order.currency
      || Number(wallet.balance) < total
    ) {
      throw new ApiError(
        409,
        "WALLET_INSUFFICIENT_FUNDS",
        "Fund the wallet before placing this order",
      );
    }
    const updated = await tx.run(`
      UPDATE wallet_accounts SET balance = balance - ?, updated_at = ?
      WHERE organization_id = ? AND balance >= ?
    `, total, createdAt, order.buyer_organization_id, total);
    if (updated.changes !== 1) {
      throw new Error("Wallet debit lost its compare-and-set");
    }
    await tx.run(`
      INSERT INTO wallet_transactions (
        organization_id, kind, amount, order_id, created_at
      ) VALUES (?, 'purchase', ?, ?, ?)
    `, order.buyer_organization_id, total, orderId, createdAt);
    await tx.run(
      "UPDATE orders SET status = 'paid', wallet_paid_at = ?, updated_at = ? WHERE id = ? AND status = 'payment_pending'",
      createdAt,
      createdAt,
      orderId,
    );
    await tx.run(`
      INSERT INTO audit_events (
        aggregate_type, aggregate_id, organization_id, event_type, actor_type,
        actor_subject, request_id, payload_json, created_at
      ) VALUES ('order', ?, ?, 'wallet.debited', 'system', NULL, ?, ?, ?)
    `, orderId, order.buyer_organization_id, requestId, JSON.stringify({
      amountMinor: total,
      currency: order.currency,
    }), createdAt);
  });
}
