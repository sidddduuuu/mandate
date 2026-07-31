import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { NeedsClient } from "./NeedsClient";

export default async function NeedsPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Purchase list" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <p className="flow-kicker">2 · Agent purchase list</p>
        <h1>Needs</h1>
        <p>
          Lines the buyer agent wants to procure. Ask the agent to place governed orders, then
          approve exceptions as the store owner.
        </p>
      </header>
      <NeedsClient />
    </main>
  );
}
