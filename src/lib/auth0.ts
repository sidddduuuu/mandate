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
    !cfg.AUTH0_SECRET ||
    cfg.AUTH_TEST_MODE
  ) {
    // AUTH_TEST_MODE keeps the local demo cookie path instead of Universal Login.
    client = null;
    return client;
  }

  // Human Universal Login only needs OIDC scopes. Do not send AUTH0_AUDIENCE
  // unless that API exists in the tenant — a missing API causes
  // "An error occurred during the authorization flow."
  const authorizationParameters: {
    scope: string;
    audience?: string;
  } = {
    scope: "openid profile email",
  };
  if (process.env.AUTH0_INCLUDE_AUDIENCE_IN_LOGIN === "1" && cfg.AUTH0_AUDIENCE) {
    authorizationParameters.audience = cfg.AUTH0_AUDIENCE;
  }

  client = new Auth0Client({
    domain: cfg.AUTH0_DOMAIN,
    clientId: cfg.AUTH0_CLIENT_ID,
    clientSecret: cfg.AUTH0_CLIENT_SECRET,
    secret: cfg.AUTH0_SECRET,
    appBaseUrl: cfg.APP_BASE_URL,
    authorizationParameters,
    session: {
      rolling: true,
      inactivityDuration: 24 * 60 * 60,
      absoluteDuration: 7 * 24 * 60 * 60,
    },
    async onCallback(error, context) {
      if (error) {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        const detail =
          cause?.message ||
          error.message ||
          "An error occurred during the authorization flow.";
        const code = cause?.code || (error as { code?: string }).code || "authorization_error";
        console.error("auth0_callback_error", { code, detail, returnTo: context.returnTo });
        const url = new URL("/auth/error", cfg.APP_BASE_URL);
        url.searchParams.set("code", code);
        url.searchParams.set("detail", detail);
        return Response.redirect(url);
      }
      return Response.redirect(new URL(context.returnTo || "/approvals", cfg.APP_BASE_URL));
    },
  });
  return client;
}

export function resetAuth0Client(): void {
  client = undefined;
}
