import type { Metadata } from "next";

import { loadDashboardSnapshot } from "../../../src/dashboard";
import { FundWallet } from "./fund-wallet";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wallet — Mandate" };

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(minor / 100);
}

export default async function WalletPage() {
  const snapshot = await loadDashboardSnapshot();
  const { wallet, order } = snapshot;
  const stripeEvents = snapshot.events.filter((event) =>
    event.title.toLowerCase().includes("stripe")
  );

  return (
    <>
      <header className="app-page-title wallet-title">
        <p className="eyebrow">Prepaid operating wallet</p>
        <h1>{money(wallet.availableMinor)}</h1>
        <p>The inventory agent can request spend from this balance. It never receives card or bank credentials.</p>
      </header>
      <section className="wallet-ledger">
        <div>
          <p className="eyebrow">Wallet controls</p>
          <FundWallet balanceMinor={wallet.availableMinor} />
          <dl>
            <div><dt>Stripe funding</dt><dd>{money(wallet.openingBalanceMinor)}</dd></div>
            <div><dt>Settled purchases</dt><dd>−{money(wallet.spentMinor)}</dd></div>
            <div><dt>Available</dt><dd>{money(wallet.availableMinor)}</dd></div>
            <div><dt>Agent limit per order</dt><dd>{money(snapshot.autonomousLimitMinor)}</dd></div>
          </dl>
        </div>
        <div className="stripe-proof">
          <p className="eyebrow">Stripe connection · test mode</p>
          <h2>Payment rail connected</h2>
          <p>Stripe Checkout collects the funding payment. Only a signature-verified Stripe webhook can credit the wallet.</p>
          <dl>
            <div><dt>Latest order</dt><dd>{order?.id.slice(0, 8) ?? "—"}</dd></div>
            <div><dt>PaymentIntent</dt><dd>{order?.paymentIntentId ? `…${order.paymentIntentId.slice(-10)}` : "Not created"}</dd></div>
            <div><dt>Webhook</dt><dd>{order?.status === "paid" ? "✓ Reconciled" : "Waiting"}</dd></div>
          </dl>
        </div>
      </section>
      <section className="wallet-events">
        <div className="panel-heading"><div><p className="eyebrow">Stripe evidence</p><h2>Settlement events</h2></div></div>
        {wallet.topups.map((topup) => (
          <div key={topup.id}>
            <time>{new Date(topup.createdAt).toLocaleTimeString("en-US")}</time>
            <strong>Wallet funding · {money(topup.amountMinor)}</strong>
            <span>{topup.status} · {topup.paymentIntentId ? `PaymentIntent …${topup.paymentIntentId.slice(-10)}` : "creating"}</span>
          </div>
        ))}
        {stripeEvents.map((event) => (
          <div key={event.id}><time>{event.time}</time><strong>{event.title}</strong><span>{event.detail}</span></div>
        ))}
      </section>
    </>
  );
}
