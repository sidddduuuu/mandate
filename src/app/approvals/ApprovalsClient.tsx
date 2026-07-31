"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, type OrderView } from "@/lib/client-api";
import { formatMoney, formatWhen } from "@/lib/format";

export function ApprovalsClient() {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ approvals: OrderView[] }>("/api/approvals");
        if (!cancelled) setOrders(data.approvals);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!orders) return <p className="muted">Loading approvals…</p>;
  if (orders.length === 0) {
    return (
      <p className="empty">
        No pending approvals. Wait for an agent request above the autonomous limit.
      </p>
    );
  }

  return (
    <div className="list">
      {orders.map((order) => (
        <Link key={order.id} className="list-row" href={`/orders/${order.id}`}>
          <div>
            <strong>
              {order.quantity} {order.unit} {order.product_key}
            </strong>
            <div className="meta">
              SKU {order.sku} · {order.delivery_location_id}
            </div>
          </div>
          <div className="meta">
            {formatMoney(order.total_minor, order.currency)}
            <div>Expires {formatWhen(order.approval_expires_at)}</div>
          </div>
          <StatusBadge status={order.status} />
          <span className="btn btn-ghost-dark btn-sm">
            Review <span className="arrow" aria-hidden>
              →
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
