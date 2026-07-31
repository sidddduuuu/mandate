import { getAuth0Client } from "@/lib/auth0";
import { readLocalSession, type UiSession } from "@/lib/local-session";

/** Thin helpers so pages can render without a live Auth0 tenant. */
export const auth0 = {
  async getSessionSafe(): Promise<UiSession | null> {
    const client = getAuth0Client();
    if (client) {
      try {
        const session = await client.getSession();
        if (session?.user?.sub) {
          const orgFromSession =
            typeof session.user.org_id === "string" ? session.user.org_id : null;
          return {
            user: {
              sub: session.user.sub,
              email: session.user.email,
              name: session.user.name,
              org_id: orgFromSession ?? process.env.SEED_BUYER_AUTH0_ORG_ID ?? null,
            },
          };
        }
      } catch {
        // fall through to local session
      }
    }
    return readLocalSession();
  },
};
