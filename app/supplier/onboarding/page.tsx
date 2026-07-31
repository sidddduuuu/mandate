import { redirect } from "next/navigation";

import { getAuth0Client } from "../../../src/auth/client.ts";
import {
  actorFromHumanClaims,
  humanClaimsFromSession,
} from "../../../src/auth/session.ts";
import { withDatabase } from "../../../src/db.ts";
import { getSupplierPaymentStatus } from "../../../src/payments/connect.ts";
import { SupplierOnboarding } from "./onboarding";

export const dynamic = "force-dynamic";

export default async function SupplierOnboardingPage() {
  const session = await getAuth0Client().getSession();
  if (!session) redirect("/auth/login?returnTo=%2Fsupplier%2Fonboarding");
  const actor = actorFromHumanClaims(humanClaimsFromSession(session), {
    permission: "openid",
  });
  const status = await withDatabase((database) =>
    getSupplierPaymentStatus(database, actor)
  );
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();

  return (
    <main className="dashboard-page" id="dashboard-content">
      <header className="app-page-title">
        <p className="eyebrow">Supplier payouts</p>
        <h1>Connect your Stripe account</h1>
        <p>Stripe collects identity and bank details. Mandate stores only payout readiness.</p>
      </header>
      <section className="supplier-workspace" aria-label="Stripe onboarding">
        <div className="panel-heading">
          <h2>{status.payoutReady ? "Ready for automatic settlement" : "Onboarding required"}</h2>
          <span>{status.stripeTransfersStatus}</span>
        </div>
        {publishableKey?.startsWith("pk_test_")
          ? <SupplierOnboarding publishableKey={publishableKey} />
          : <p>Stripe test-mode publishable key is not configured.</p>}
      </section>
    </main>
  );
}
