import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import { getConfig } from "./config";

/** Minimal surface used by Mandate auth (real SDK or test double). */
export type Auth0SessionClient = {
  getSession(req?: unknown): Promise<SessionData | null>;
  middleware?(req: Request): Promise<Response>;
};

let client: Auth0SessionClient | null | undefined;
let testOverride: Auth0SessionClient | null | undefined;

/**
 * Auth0 Next.js SDK client (v4).
 * Lazy so unit tests and agent-only paths do not require a full Auth0 app.
 */
export function getAuth0Client(): Auth0SessionClient | null {
  if (testOverride !== undefined) return testOverride;
  if (client !== undefined) return client;

  const cfg = getConfig();
  if (
    !cfg.AUTH0_DOMAIN ||
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

export function setAuth0ClientForTests(override: Auth0SessionClient | null | undefined): void {
  testOverride = override;
}

export function resetAuth0Client(): void {
  client = undefined;
  testOverride = undefined;
}