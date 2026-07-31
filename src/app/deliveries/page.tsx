import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { DeliveriesClient } from "./DeliveriesClient";

export default async function DeliveriesPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Deliveries" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <p className="flow-kicker">4 · Inbound &amp; restock</p>
        <h1>Deliveries</h1>
        <p>
          After payment, the agent tracks packing → ship → delivery. When a delivery lands,
          inventory is updated automatically.
        </p>
      </header>
      <DeliveriesClient />
    </main>
  );
}
