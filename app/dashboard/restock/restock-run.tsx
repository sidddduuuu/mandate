"use client";

import { useEffect, useRef, useState } from "react";

const items = [
  {
    productKey: "hass-avocado",
    name: "Hass avocados",
    quantity: 10,
    idempotencyKey: "00000000-0000-4000-8000-000000001001",
  },
  {
    productKey: "persian-lime",
    name: "Persian limes",
    quantity: 10,
    idempotencyKey: "00000000-0000-4000-8000-000000001002",
  },
  {
    productKey: "cilantro",
    name: "Cilantro",
    quantity: 6,
    idempotencyKey: "00000000-0000-4000-8000-000000001003",
  },
] as const;

type RunStatus = "queued" | "sourcing" | "paying" | "paid" | "failed";

async function waitForPayment(orderId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`/api/orders/${orderId}/approval`, {
      cache: "no-store",
    });
    const payload = await response.json() as {
      data?: { status?: string };
    };
    if (payload.data?.status === "paid") return;
    if (["payment_failed", "cancelled", "rejected"].includes(
      payload.data?.status ?? "",
    )) throw new Error(`Payment ended as ${payload.data?.status}`);
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  throw new Error("Stripe confirmation timed out");
}

export function RestockRun() {
  const started = useRef(false);
  const [statuses, setStatuses] = useState<RunStatus[]>(
    items.map(() => "queued"),
  );
  const [message, setMessage] = useState("Authenticating inventory agent…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const update = (index: number, status: RunStatus) => {
      setStatuses((current) =>
        current.map((value, itemIndex) => itemIndex === index ? status : value)
      );
    };
    const run = async () => {
      setMessage("Auth0 session verified. Sourcing low-stock inventory.");
      for (const [index, item] of items.entries()) {
        try {
          update(index, "sourcing");
          const response = await fetch("/api/demo/agent-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productKey: item.productKey,
              quantity: item.quantity,
              idempotencyKey: item.idempotencyKey,
            }),
          });
          const payload = await response.json() as {
            data?: { orderId?: string };
            error?: { message?: string };
          };
          if (!response.ok || !payload.data?.orderId) {
            throw new Error(payload.error?.message || "Sourcing failed");
          }
          update(index, "paying");
          await waitForPayment(payload.data.orderId);
          update(index, "paid");
        } catch (cause) {
          update(index, "failed");
          setMessage(cause instanceof Error ? cause.message : "Restock failed");
          return;
        }
      }
      setMessage("Restock complete. Every order was confirmed by Stripe.");
    };
    void run();
  }, []);

  return (
    <>
      <header className="app-page-title restock-title">
        <p className="eyebrow">Codex automation · Auth0 verified</p>
        <h1>Restocking<br />low inventory.</h1>
        <p>{message}</p>
      </header>
      <section className="restock-progress" aria-live="polite">
        {items.map((item, index) => (
          <div key={item.productKey}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{item.name}</strong>
            <span>{item.quantity} cases</span>
            <span className={`run-${statuses[index]}`}>{statuses[index]}</span>
          </div>
        ))}
      </section>
      {statuses.every((status) => status === "paid") && (
        <nav className="restock-results" aria-label="Restock results">
          <a href="/dashboard/orders">View orders →</a>
          <a href="/dashboard/wallet">View Stripe settlement →</a>
          <a href="/dashboard/audit">View audit evidence →</a>
        </nav>
      )}
    </>
  );
}
