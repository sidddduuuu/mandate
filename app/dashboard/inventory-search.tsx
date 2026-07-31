"use client";

import { useState } from "react";

const lowInventory = [
  ["hass-avocado", "Hass avocados", "🥑", "2 cases", "12 cases", 10, "Critical"],
  ["persian-lime", "Persian limes", "🍋‍🟩", "4 cases", "14 cases", 10, "Low"],
  ["cilantro", "Cilantro", "🌿", "1 case", "7 cases", 6, "Low"],
] as const;

export function InventorySearch() {
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const items = lowInventory.filter(([, name]) =>
    name.toLowerCase().includes(query.trim().toLowerCase())
  );

  const source = async (productKey: string, quantity: number) => {
    setRunning(productKey);
    setError("");
    try {
      const response = await fetch("/api/demo/agent-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productKey, quantity }),
      });
      const payload = await response.json() as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message || "Sourcing run failed");
      }
      window.location.href = "/dashboard/orders";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sourcing run failed");
      setRunning("");
    }
  };

  return (
    <section className="inventory-panel" aria-labelledby="inventory-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Inventory exceptions</p>
          <h2 id="inventory-title">Running low</h2>
        </div>
        <label className="inventory-search">
          <span className="sr-only">Search low inventory</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search inventory"
          />
        </label>
      </div>

      <div className="inventory-table" role="table" aria-label="Low inventory">
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Item</span>
          <span role="columnheader">On hand</span>
          <span role="columnheader">Target</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Action</span>
        </div>
        {items.map(([productKey, name, emoji, onHand, target, quantity, urgency]) => (
          <div className="inventory-row" role="row" key={productKey}>
            <strong role="cell"><span aria-hidden="true">{emoji}</span> {name}</strong>
            <span role="cell">{onHand}</span>
            <span role="cell">{target}</span>
            <span role="cell" className="inventory-status">● {urgency}</span>
            <button
              type="button"
              disabled={Boolean(running)}
              onClick={() => void source(productKey, quantity)}
            >
              {running === productKey ? "Sourcing…" : "Source vendors →"}
            </button>
          </div>
        ))}
      </div>
      {items.length === 0 && <p className="empty-result">No low-stock items match “{query}”.</p>}
      {error && <p className="action-message" role="alert">{error}</p>}
    </section>
  );
}
