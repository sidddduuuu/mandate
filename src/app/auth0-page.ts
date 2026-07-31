import { getAuth0Client } from "@/lib/auth0";

/** Thin helpers so the home page can render without Auth0 env in tests/builds. */
export const auth0 = {
  async getSessionSafe() {
    const client = getAuth0Client();
    if (!client) return null;
    try {
      return await client.getSession();
    } catch {
      return null;
    }
  },
};
