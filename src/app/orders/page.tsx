import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { OrdersClient } from "./OrdersClient";

export default async function OrdersPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Orders" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <h1>Orders</h1>
        <p>Organization purchase history—from policy decision through Stripe settlement.</p>
      </header>
      <OrdersClient />
    </main>
  );
}
