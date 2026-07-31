import type { Db } from "@/db";
import type { ActorContext } from "@/auth/context";

/** Synthetic buyer-agent actor for store-owner demo actions (AUTH_TEST_MODE UI). */
export function buyerAgentForOrg(
  db: Db,
  human: ActorContext,
): ActorContext {
  const org = db
    .prepare(`SELECT id, auth0_org_id FROM organizations WHERE id = ?`)
    .get(human.organizationId) as { id: string; auth0_org_id: string } | undefined;
  if (!org) {
    throw new Error("Organization not found");
  }
  return {
    actorType: "agent",
    subject: "buyer-agent@mandate.local",
    organizationId: org.id,
    auth0OrgId: org.auth0_org_id,
    scopes: new Set(["orders:create", "orders:read", "offers:read"]),
    permissions: new Set(),
  };
}
