import { LoginGate } from "@/components/LoginGate";
import { auth0 } from "@/app/auth0-page";
import { OrderDetailClient } from "./OrderDetailClient";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  if (!session?.user) {
    return (
      <main id="main">
        <LoginGate orgHint={orgHint} title="Order" />
      </main>
    );
  }

  return (
    <main id="main" className="app-shell">
      <OrderDetailClient orderId={id} />
    </main>
  );
}
