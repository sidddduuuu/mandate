"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, type AuditEventView, type OrderView } from "@/lib/client-api";
import { formatMoney, formatWhen } from "@/lib/format";

/**
 * There is no list-orders API yet; derive recent order IDs from the org audit trail
 * and hydrate each order via GET /api/orders/:id.
 */
export function OrdersClient() {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const audit = await apiGet<{ events: AuditEventView[] }>("/api/audit");
        const ids: string[] = [];
        for (const ev of audit.events) {
          if (ev.aggregate_type === "order" && !ids.includes(ev.aggregate_id)) {
            ids.push(ev.aggregate_id);
          }
          if (ids.length >= 24) break;
        }
        const hydrated = await Promise.all(
          ids.map(async (id) => {
            try {
              return await apiGet<OrderView>(`/api/orders/${id}`);
            } catch {
              return null;
            }
          }),
        );
        if (!cancelled) setOrders(hydrated.filter((o): o is OrderView => Boolean(o)));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!orders) return <p className="muted">Loading orders…</p>;
  if (orders.length === 0) return <p className="empty">No orders in the audit trail yet.</p>;

  return (
    <div className="list">
      {orders.map((order) => (
        <Link key={order.id} className="list-row" href={`/orders/${order.id}`}>
          <div>
            <strong>
              {order.quantity} {order.unit} {order.product_key}
            </strong>
            <div className="meta mono">{order.id}</div>
          </div>
          <div className="meta">
            {formatMoney(order.total_minor, order.currency)}
            <div>{formatWhen(order.created_at)}</div>
          </div>
          <StatusBadge status={order.status} />
          <span className="btn btn-ghost-dark btn-sm">
            Open <span className="arrow" aria-hidden>
              →
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
