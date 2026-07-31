"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, apiMutate, type OrderView } from "@/lib/client-api";
import { formatMoney, formatWhen } from "@/lib/format";

export function OrderDetailClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<OrderView>(`/api/orders/${orderId}`);
    setOrder(data);
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiMutate<OrderView>(`/api/orders/${orderId}/approval`, {
        method: "POST",
        body: { decision, reason: reason || undefined },
      });
      setOrder(updated);
      setNotice(decision === "approve" ? "Approved — payment initiated." : "Rejected.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function abandon() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiMutate<OrderView>(`/api/orders/${orderId}/abandon`, {
        method: "POST",
        body: {},
      });
      setOrder(updated);
      setNotice("Payment abandoned and budget released.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !order) {
    return (
      <div>
        <div className="alert" role="alert">
          {error}
        </div>
        <Link href="/approvals">Back to approvals</Link>
      </div>
    );
  }

  if (!order) return <p className="muted">Loading order…</p>;

  const awaiting = order.status === "awaiting_approval";
  const failed = order.status === "payment_failed";

  return (
    <div>
      <header className="app-hero">
        <p className="muted">
          <Link href="/approvals">Approvals</Link> / <span className="mono">{order.id}</span>
        </p>
        <h1>
          {order.quantity} {order.unit} {order.product_key}
        </h1>
        <p>
          Exact exception review for {formatMoney(order.total_minor, order.currency)} ·{" "}
          <StatusBadge status={order.status} />
        </p>
      </header>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      ) : null}

      <div className="detail-grid">
        <section className="detail-block">
          <h2>Order snapshot</h2>
          <dl className="kv">
            <dt>SKU</dt>
            <dd>{order.sku}</dd>
            <dt>Category</dt>
            <dd>{order.category}</dd>
            <dt>Unit price</dt>
            <dd>{formatMoney(order.unit_price_minor, order.currency)}</dd>
            <dt>Total</dt>
            <dd>{formatMoney(order.total_minor, order.currency)}</dd>
            <dt>Delivery</dt>
            <dd>{order.delivery_location_id}</dd>
            <dt>Created</dt>
            <dd>{formatWhen(order.created_at)}</dd>
            <dt>Approval expires</dt>
            <dd>{formatWhen(order.approval_expires_at)}</dd>
            <dt>PaymentIntent</dt>
            <dd className="mono">{order.stripe_payment_intent_id ?? "—"}</dd>
          </dl>
        </section>

        <section className="detail-block">
          <h2>Policy</h2>
          <dl className="kv">
            <dt>Decision</dt>
            <dd>{order.policy_decision}</dd>
            <dt>Reasons</dt>
            <dd>{order.policy_reasons?.length ? order.policy_reasons.join(", ") : "—"}</dd>
            <dt>Mandate</dt>
            <dd>v{order.mandate_version ?? "—"}</dd>
          </dl>

          {awaiting ? (
            <div className="form-stack" style={{ marginTop: "1.25rem", maxWidth: "none" }}>
              <div className="field">
                <label htmlFor="reason">Decision reason (optional)</label>
                <textarea
                  id="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Weekly produce restock"
                />
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void decide("approve")}
                >
                  Approve &amp; pay
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void decide("reject")}
                >
                  Reject
                </button>
              </div>
            </div>
          ) : null}

          {failed ? (
            <div className="actions">
              <button type="button" className="btn btn-ghost-dark" disabled={busy} onClick={() => void abandon()}>
                Abandon failed payment
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
