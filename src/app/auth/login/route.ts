import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { lookupOrgByAuth0Id } from "@/auth/context";
import { getAuth0Client } from "@/lib/auth0";
import {
  buildLocalSessionValue,
  COOKIE_NAME,
  isAuth0Configured,
  usesLocalHumanAuth,
} from "@/lib/local-session";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Human login entrypoint.
 * - Auth0 configured + AUTH_TEST_MODE off → Auth0 Universal Login
 * - Otherwise → local demo mandate_session cookie
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orgHint =
    url.searchParams.get("organization")?.trim() ||
    process.env.SEED_BUYER_AUTH0_ORG_ID ||
    "org_buyer";
  const returnTo = url.searchParams.get("returnTo")?.trim() || "/approvals";

  const auth0 = getAuth0Client();
  if (auth0 && isAuth0Configured() && !getConfig().AUTH_TEST_MODE) {
    // Only pass organization when the Auth0 Application allows it
    // (Settings → Organizations → Organization Usage ≠ Deny).
    // Otherwise Universal Login fails with "organization is not allowed".
    const passOrganization = process.env.AUTH0_PASS_ORGANIZATION === "1";
    return auth0.startInteractiveLogin({
      returnTo: returnTo.startsWith("/") ? returnTo : "/approvals",
      authorizationParameters: passOrganization
        ? { organization: orgHint }
        : undefined,
    });
  }

  if (!usesLocalHumanAuth()) {
    return NextResponse.json(
      {
        error: {
          code: "auth_misconfigured",
          message: "Configure Auth0 or enable AUTH_TEST_MODE=1 for local login.",
        },
      },
      { status: 500 },
    );
  }

  try {
    const db = getDb();
    lookupOrgByAuth0Id(db, orgHint);
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "unknown_organization",
          message: `Unknown organization ${orgHint}. Run npm run seed first.`,
        },
      },
      { status: 400 },
    );
  }

  const value = buildLocalSessionValue({ orgId: orgHint });
  const cfg = getConfig();
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const origin =
    host && !host.startsWith("0.0.0.0")
      ? `${proto}://${host}`
      : cfg.APP_BASE_URL || url.origin;
  const dest = new URL(returnTo.startsWith("/") ? returnTo : "/approvals", origin);
  const res = NextResponse.redirect(dest);
  res.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
