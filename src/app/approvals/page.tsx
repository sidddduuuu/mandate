import Link from "next/link";
import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { ApprovalsClient } from "./ApprovalsClient";

export default async function ApprovalsPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Approvals" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <p className="flow-kicker">3 · Store owner decision</p>
        <h1>Approvals</h1>
        <p>
          Exception spend the buyer agent cannot take alone—exact amount, offer, and mandate
          version for your sign-off.
        </p>
      </header>
      <ApprovalsClient />
      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Looking for history? <Link href="/orders">Open orders</Link>
      </p>
    </main>
  );
}
