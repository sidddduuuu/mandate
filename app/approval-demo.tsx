"use client";

import { useEffect, useState } from "react";

import type { DashboardSnapshot } from "../src/dashboard";

type Status = "review" | "payment" | "paid" | "failed" | "rejected";

function initialStatus(status: string | undefined): Status {
  if (status === "paid") return "paid";
  if (status === "payment_pending") return "payment";
  if (status === "payment_failed" || status === "cancelled") return "failed";
  if (status && ["rejected", "expired", "stale"].includes(status)) {
    return "rejected";
  }
  return "review";
}

function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function ApprovalDemo({
  snapshot,
}: Readonly<{ snapshot: DashboardSnapshot }>) {
  const { order } = snapshot;
  const [status, setStatus] = useState<Status>(initialStatus(order?.status));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!order || status !== "payment") return;
    const controller = new AbortController();
    const checkPayment = async () => {
      const response = await fetch(`/api/orders/${order.id}/approval`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = await response.json() as { data?: { status?: string } };
      if (payload.data?.status === "paid") window.location.reload();
      if (["payment_failed", "cancelled"].includes(payload.data?.status ?? "")) {
        setStatus("failed");
      }
    };
    void checkPayment().catch(() => setError("Could not refresh payment status"));
    const timer = window.setInterval(
      () => void checkPayment().catch(() => setError("Could not refresh payment status")),
      750,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [order, status]);

  const decide = async (decision: "approve" | "reject") => {
    if (!order || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/${order.id}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason: note.trim() || undefined }),
      });
      const payload = await response.json() as {
        data?: { status?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message || "Decision failed");
      }
      setStatus(payload.data?.status === "rejected" ? "rejected" : "payment");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  };

  if (!order) {
    return (
      <div className="empty-state">
        <h2>No orders yet.</h2>
        <a href="/dashboard">Source low-stock inventory →</a>
      </div>
    );
  }

  return (
    <div className="order-workspace">
      <section className="order-summary">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Order · {order.id.slice(0, 8)}</p>
            <h2>🥑 {order.productName}</h2>
          </div>
          <span className={`order-status status-${status}`}>● {
            status === "review" ? "Approval required" :
            status === "payment" ? "Wallet settling" :
            status === "paid" ? "Paid" :
            status === "failed" ? "Payment failed" : "Rejected"
          }</span>
        </div>

        <dl className="order-facts">
          <div><dt>Agent</dt><dd>{order.requester}</dd></div>
          <div><dt>Supplier</dt><dd>{order.supplierName}</dd></div>
          <div><dt>Quantity</dt><dd>{order.quantity} {order.unit}s</dd></div>
          <div><dt>Total</dt><dd>{money(order.totalMinor, order.currency)}</dd></div>
          <div><dt>Deliver to</dt><dd>{order.deliveryLocation.replaceAll("-", " ")}</dd></div>
          <div><dt>Mandate</dt><dd>M-104 v{order.mandateVersion}</dd></div>
        </dl>

        <a className="inline-route-link" href="/dashboard/suppliers">
          View all vendor offers →
        </a>
      </section>

      <aside className="payment-panel">
        <p className="eyebrow">Prepaid wallet payment</p>
        <h2>{money(snapshot.wallet.availableMinor)}</h2>
        <p>Available to the agent. Card and bank details remain server-side.</p>

        <dl className="payment-flow">
          <div><dt>1</dt><dd>Stripe securely funds the wallet</dd></div>
          <div><dt>2</dt><dd>Human or mandate approves the spend</dd></div>
          <div><dt>3</dt><dd>Backend debits the wallet atomically</dd></div>
        </dl>

        {status === "review" && (
          <div className="decision-actions">
            <label htmlFor="decision-note">Approval note · optional</label>
            <textarea
              id="decision-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="Add context for the audit trail"
            />
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {busy ? "Processing…" : `Approve wallet payment ${money(order.totalMinor, order.currency)} →`}
            </button>
            <button
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={() => void decide("reject")}
            >
              Reject order
            </button>
          </div>
        )}
        {status === "payment" && <p className="payment-proof">Debiting the funded wallet…</p>}
        {status === "paid" && (
          <p className="payment-proof">
            {order.paymentIntentId
              ? `✓ Paid directly by Stripe · …${order.paymentIntentId.slice(-10)}`
              : "✓ Paid from the Stripe-funded wallet"}
          </p>
        )}
        {status === "failed" && <p className="action-message">Stripe did not complete payment.</p>}
        {status === "rejected" && <p className="action-message">No payment was created.</p>}
        {error && <p className="action-message" role="alert">{error}</p>}
      </aside>
    </div>
  );
}
