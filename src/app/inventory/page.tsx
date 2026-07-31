import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { InventoryClient } from "./InventoryClient";

export default async function InventoryPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Inventory" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <p className="flow-kicker">1 · Store stock</p>
        <h1>Inventory</h1>
        <p>
          Your buyer agent watches on-hand levels against reorder points, then builds a purchase
          list when the kitchen runs short.
        </p>
      </header>
      <InventoryClient />
    </main>
  );
}
