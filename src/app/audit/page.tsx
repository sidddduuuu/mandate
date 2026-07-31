import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { AuditClient } from "./AuditClient";

export default async function AuditPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Audit" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <h1>Audit trail</h1>
        <p>Append-only decisions for your organization—identity, policy, approval, and payment.</p>
      </header>
      <AuditClient />
    </main>
  );
}
