import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { AuthError } from "./context.ts";

const HUMAN_SCOPES =
  "openid profile email mandates:write approvals:read approvals:decide orders:read";
const LOGIN_SCOPES = "openid profile email";

let client: Auth0Client | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AuthError("invalid_configuration");
  return value;
}

export function getAuth0Client(): Auth0Client {
  const domain = required("AUTH0_DOMAIN");
  const clientId = required("AUTH0_CLIENT_ID");
  const clientSecret = required("AUTH0_CLIENT_SECRET");
  const secret = required("AUTH0_SECRET");
  const audience = process.env.AUTH0_AUDIENCE?.trim();
  const appBaseUrl = required("APP_BASE_URL");

  let baseUrl: URL;
  try {
    baseUrl = new URL(appBaseUrl);
  } catch (cause) {
    throw new AuthError("invalid_configuration", { cause });
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    (process.env.NODE_ENV === "production" && baseUrl.protocol !== "https:")
  ) {
    throw new AuthError("invalid_configuration");
  }

  client ??= new Auth0Client({
    domain,
    clientId,
    clientSecret,
    secret,
    appBaseUrl: baseUrl.origin,
    authorizationParameters: audience
      ? { audience, scope: HUMAN_SCOPES }
      : { scope: LOGIN_SCOPES },
    logoutStrategy: "v2",
    enableAccessTokenEndpoint: false,
  });
  return client;
}
