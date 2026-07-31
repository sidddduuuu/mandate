import type { Metadata } from "next";

import { ApprovalDemo } from "../../approval-demo";
import { loadDashboardSnapshot } from "../../../src/dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Orders — Mandate" };

export default async function OrdersPage() {
  const snapshot = await loadDashboardSnapshot();
  return (
    <>
      <header className="app-page-title">
        <p className="eyebrow">Agent purchases</p>
        <h1>Orders</h1>
        <p>Review the selected vendor, authorize wallet spend, and watch Stripe settle the payment.</p>
      </header>
      <ApprovalDemo snapshot={snapshot} />
    </>
  );
}
