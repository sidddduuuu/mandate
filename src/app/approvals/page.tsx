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
        <h1>Approvals</h1>
        <p>Orders paused for a human decision—exact amount, offer, and mandate version.</p>
      </header>
      <ApprovalsClient />
      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Looking for history? <Link href="/orders">Open orders</Link>
      </p>
    </main>
  );
}
