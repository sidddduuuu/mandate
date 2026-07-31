import type { Metadata } from "next";

import { loadDashboardSnapshot } from "../../../src/dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Suppliers — Mandate" };

function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minor / 100);
}

export default async function SuppliersPage() {
  const snapshot = await loadDashboardSnapshot();
  return (
    <>
      <header className="app-page-title">
        <p className="eyebrow">Registered vendor network</p>
        <h1>Suppliers</h1>
        <p>The agent only searches approved catalog offers that match unit, stock, currency, and delivery rules.</p>
      </header>
      <section className="supplier-workspace">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Latest sourcing run</p>
            <h2>{snapshot.order?.productName ?? "No active item"}</h2>
          </div>
          <span>{snapshot.offers.length} eligible offers</span>
        </div>
        <table className="supplier-table">
          <thead><tr><th>Vendor</th><th>Total</th><th>Eligibility</th><th>Agent decision</th></tr></thead>
          <tbody>
            {snapshot.offers.map((offer) => (
              <tr className={offer.selected ? "supplier-selected" : ""} key={offer.supplierName}>
                <td>{offer.supplierName}</td>
                <td>{money(offer.totalMinor, snapshot.order?.currency)}</td>
                <td>Approved · stock verified</td>
                <td>{offer.selected ? "✓ Selected · lowest price" : "Eligible"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
