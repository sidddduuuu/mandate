"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, apiMutate } from "@/lib/client-api";
import { formatWhen } from "@/lib/format";

type Delivery = {
  id: string;
  order_id: string;
  product_key: string;
  quantity: number;
  unit: string;
  location_id: string;
  status: string;
  eta_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  inventory_applied: boolean;
  next_status: string | null;
};

const STEPS = ["packing", "shipped", "out_for_delivery", "delivered"] as const;

export function DeliveriesClient() {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await apiGet<{ deliveries: Delivery[] }>("/api/deliveries");
    setDeliveries(data.deliveries);
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

  async function advance(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiMutate(`/api/deliveries/${id}/advance`, { method: "POST", body: {} });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (error && !deliveries) {
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  }
  if (!deliveries) return <p className="muted">Loading deliveries…</p>;

  return (
    <div>
      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}

      {deliveries.length === 0 ? (
        <p className="empty">
          No inbound deliveries yet. Approve a purchase so payment can start packing.
        </p>
      ) : (
        <div className="list">
          {deliveries.map((d) => {
            const stepIndex = STEPS.indexOf(d.status as (typeof STEPS)[number]);
            return (
              <div key={d.id} className="list-row list-row-static delivery-row">
                <div>
                  <strong>
                    {d.quantity} {d.unit} {d.product_key}
                  </strong>
                  <div className="meta">
                    To {d.location_id} ·{" "}
                    <Link className="mono" href={`/orders/${d.order_id}`}>
                      {d.order_id.slice(0, 18)}…
                    </Link>
                  </div>
                  <ol className="delivery-steps" aria-label="Delivery progress">
                    {STEPS.map((step, i) => (
                      <li
                        key={step}
                        className={
                          stepIndex >= i ? "delivery-step delivery-step-done" : "delivery-step"
                        }
                      >
                        {step.replaceAll("_", " ")}
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="meta">
                  ETA {formatWhen(d.eta_at)}
                  {d.shipped_at ? <div>Shipped {formatWhen(d.shipped_at)}</div> : null}
                  {d.delivered_at ? <div>Delivered {formatWhen(d.delivered_at)}</div> : null}
                  {d.inventory_applied ? <div>Inventory restocked</div> : null}
                </div>
                <StatusBadge status={d.status} />
                {d.next_status ? (
                  <button
                    type="button"
                    className="btn btn-ghost-dark btn-sm"
                    disabled={busyId === d.id}
                    onClick={() => void advance(d.id)}
                  >
                    Mark {d.next_status.replaceAll("_", " ")}
                  </button>
                ) : (
                  <Link className="btn btn-ghost-dark btn-sm" href="/inventory">
                    View stock <span className="arrow" aria-hidden>→</span>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
