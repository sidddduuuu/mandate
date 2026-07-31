import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { getConfig } from "./config";

let client: Auth0Client | null | undefined;

/**
 * Auth0 Next.js SDK client (v4).
 * Lazy so unit tests and agent-only paths do not require a full Auth0 app.
 */
export function getAuth0Client(): Auth0Client | null {
  if (client !== undefined) return client;

  const cfg = getConfig();
  const domain = cfg.AUTH0_DOMAIN ?? "";
  const placeholderDomain =
    !domain || domain.includes("your-tenant") || domain.includes("example");
  if (
    placeholderDomain ||
    !cfg.AUTH0_CLIENT_ID ||
    !cfg.AUTH0_CLIENT_SECRET ||
    !cfg.AUTH0_SECRET
  ) {
    client = null;
    return client;
  }

  client = new Auth0Client({
    domain: cfg.AUTH0_DOMAIN,
    clientId: cfg.AUTH0_CLIENT_ID,
    clientSecret: cfg.AUTH0_CLIENT_SECRET,
    secret: cfg.AUTH0_SECRET,
    appBaseUrl: cfg.APP_BASE_URL,
    authorizationParameters: {
      scope: "openid profile email",
      audience: cfg.AUTH0_AUDIENCE,
    },
    session: {
      rolling: true,
      inactivityDuration: 24 * 60 * 60,
      absoluteDuration: 7 * 24 * 60 * 60,
    },
  });
  return client;
}

export function resetAuth0Client(): void {
  client = undefined;
}
