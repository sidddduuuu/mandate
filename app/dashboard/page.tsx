import type { Metadata } from "next";

import { loadDashboardSnapshot } from "../../src/dashboard";
import { InventorySearch } from "./inventory-search";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory overview — Mandate",
};

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export default async function Dashboard() {
  const snapshot = await loadDashboardSnapshot();
  const { order, wallet } = snapshot;

  return (
    <>
      <header className="app-page-header">
        <div>
          <p className="eyebrow">Inventory agent · live</p>
          <h1>Restock what<br />your business needs.</h1>
        </div>
        <div className="header-proof">
          <span>● Auth0 identity verified</span>
          <span>● Stripe test mode connected</span>
        </div>
      </header>

      <section className="dashboard-metrics" aria-label="Account status">
        <a href="/dashboard/wallet">
          <span>Prepaid wallet</span>
          <strong>{money(wallet.availableMinor)}</strong>
          <small>Agent never sees a card</small>
        </a>
        <div>
          <span>Items below target</span>
          <strong>3</strong>
          <small>Inventory sync · just now</small>
        </div>
        <a href="/dashboard/orders">
          <span>Latest order</span>
          <strong>{order ? money(order.totalMinor) : "—"}</strong>
          <small>{order?.status.replaceAll("_", " ") ?? "No orders"}</small>
        </a>
      </section>

      <InventorySearch />

      <section className="agent-boundary">
        <div>
          <p className="eyebrow">Agent authority</p>
          <h2>inventory-agent-prod</h2>
        </div>
        <dl>
          <div><dt>Can access</dt><dd>Inventory needs · approved vendor catalog · wallet allowance</dd></div>
          <div><dt>Cannot access</dt><dd>Card number · bank details · unrestricted company funds</dd></div>
          <div><dt>Autonomous order limit</dt><dd>{money(snapshot.autonomousLimitMinor)}</dd></div>
        </dl>
      </section>
    </>
  );
}
