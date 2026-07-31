"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, apiMutate } from "@/lib/client-api";
import { formatWhen } from "@/lib/format";

type Need = {
  id: string;
  product_key: string;
  unit: string;
  location_id: string;
  suggested_quantity: number;
  reason: string;
  status: string;
  order_id: string | null;
  detected_by_subject: string;
  created_at: string;
};

export function NeedsClient() {
  const [needs, setNeeds] = useState<Need[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<{ needs: Need[] }>("/api/needs");
    setNeeds(data.needs);
  }, []);

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

  async function placeOrders() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiMutate<{
        placed: Array<{ order: { id: string; status: string } }>;
      }>("/api/needs/order", { method: "POST", body: {} });
      await load();
      const awaiting = data.placed.filter((p) => p.order.status === "awaiting_approval").length;
      setNotice(
        data.placed.length === 0
          ? "No open needs to order."
          : `Agent placed ${data.placed.length} order${data.placed.length === 1 ? "" : "s"}${
              awaiting ? ` · ${awaiting} need your approval` : ""
            }.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiMutate("/api/needs", { method: "DELETE", body: { id } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !needs) {
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  }
  if (!needs) return <p className="muted">Loading purchase list…</p>;

  const openCount = needs.filter((n) => n.status === "open").length;

  return (
    <div>
      <div className="actions" style={{ marginBottom: "1.25rem" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || openCount === 0}
          onClick={() => void placeOrders()}
        >
          Ask agent to place orders
        </button>
        <Link className="btn btn-ghost-dark" href="/inventory">
          Back to inventory
        </Link>
        <Link className="btn btn-ghost-dark" href="/approvals">
          Approvals <span className="arrow" aria-hidden>→</span>
        </Link>
      </div>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert-ok" role="status">
          {notice}{" "}
          <Link href="/approvals">Review approvals</Link>
        </div>
      ) : null}

      {needs.length === 0 ? (
        <p className="empty">
          Purchase list is empty. Run an agent restock scan from{" "}
          <Link href="/inventory">Inventory</Link>.
        </p>
      ) : (
        <div className="list">
          {needs.map((need) => (
            <div key={need.id} className="list-row list-row-static">
              <div>
                <strong>
                  {need.suggested_quantity} {need.unit} {need.product_key}
                </strong>
                <div className="meta">
                  {need.reason} · {need.location_id}
                </div>
                <div className="meta">Detected by {need.detected_by_subject}</div>
              </div>
              <div className="meta">
                {formatWhen(need.created_at)}
                {need.order_id ? (
                  <div>
                    Order{" "}
                    <Link className="mono" href={`/orders/${need.order_id}`}>
                      {need.order_id.slice(0, 16)}…
                    </Link>
                  </div>
                ) : null}
              </div>
              <StatusBadge status={need.status} />
              {need.status === "open" ? (
                <button
                  type="button"
                  className="btn btn-ghost-dark btn-sm"
                  disabled={busy}
                  onClick={() => void dismiss(need.id)}
                >
                  Dismiss
                </button>
              ) : need.order_id ? (
                <Link className="btn btn-ghost-dark btn-sm" href={`/orders/${need.order_id}`}>
                  Open order <span className="arrow" aria-hidden>→</span>
                </Link>
              ) : (
                <span className="meta">—</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
