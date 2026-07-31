import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { MandateForm } from "./MandateForm";

export default async function MandatesPage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Mandates" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <h1>Purchasing mandate</h1>
        <p>
          Create an immutable policy version for your organization. The new version becomes the only
          active mandate.
        </p>
      </header>
      <MandateForm />
    </main>
  );
}
