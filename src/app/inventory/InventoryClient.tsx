"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiGet, apiMutate } from "@/lib/client-api";
import { formatWhen } from "@/lib/format";

type InventoryItem = {
  id: string;
  product_key: string;
  display_name: string;
  category: string;
  unit: string;
  location_id: string;
  on_hand: number;
  reorder_point: number;
  target_quantity: number;
  low_stock: boolean;
  suggested_restock: number;
  updated_at: string;
};

export function InventoryClient() {
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await apiGet<{ items: InventoryItem[] }>("/api/inventory");
    setItems(data.items);
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

  async function scan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiMutate<{ scanned: number }>("/api/inventory/scan", {
        method: "POST",
        body: {},
      });
      await load();
      setNotice(
        data.scanned > 0
          ? `Agent flagged ${data.scanned} restock need${data.scanned === 1 ? "" : "s"}.`
          : "Agent scan complete — stock is within reorder points.",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !items) {
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  }

  if (!items) return <p className="muted">Loading inventory…</p>;

  return (
    <div>
      <div className="actions" style={{ marginBottom: "1.25rem" }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void scan()}>
          {busy ? "Scanning…" : "Run agent restock scan"}
        </button>
        <Link className="btn btn-ghost-dark" href="/needs">
          Open purchase list <span className="arrow" aria-hidden>→</span>
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
          <Link href="/needs">Review needs</Link>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="empty">
          No inventory rows yet. Run the agent restock scan to seed kitchen stock levels.
        </p>
      ) : (
        <div className="list">
          {items.map((item) => (
            <div key={item.id} className="list-row list-row-static">
              <div>
                <strong>{item.display_name}</strong>
                <div className="meta">
                  {item.product_key} · {item.location_id} · {item.category}
                </div>
              </div>
              <div className="meta">
                On hand <strong style={{ fontFamily: "inherit" }}>{item.on_hand}</strong> {item.unit}
                <div>
                  Reorder at {item.reorder_point} · target {item.target_quantity}
                </div>
                <div>Updated {formatWhen(item.updated_at)}</div>
              </div>
              <StatusBadge status={item.low_stock ? "low_stock" : "in_stock"} />
              <div className="meta">
                {item.low_stock
                  ? `Suggest +${item.suggested_restock} ${item.unit}`
                  : "Healthy"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
