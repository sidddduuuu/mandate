import { NextResponse } from "next/server";
import { getAuth0Client } from "@/lib/auth0";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME, isAuth0Configured } from "@/lib/local-session";

export const runtime = "nodejs";

/** Clears Auth0 / local session and returns home. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cfg = getConfig();
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const origin =
    host && !host.startsWith("0.0.0.0")
      ? `${proto}://${host}`
      : cfg.APP_BASE_URL || url.origin;
  const returnTo = url.searchParams.get("returnTo")?.trim() || origin;

  // Prefer Auth0 middleware logout when the SDK is mounted.
  const auth0 = getAuth0Client();
  if (auth0 && isAuth0Configured() && !cfg.AUTH_TEST_MODE) {
    const logout = new URL(`https://${cfg.AUTH0_DOMAIN}/v2/logout`);
    logout.searchParams.set("client_id", cfg.AUTH0_CLIENT_ID!);
    logout.searchParams.set("returnTo", returnTo.startsWith("http") ? returnTo : origin);
    const res = NextResponse.redirect(logout);
    // Also drop any leftover local demo cookie.
    res.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: 0,
    });
    return res;
  }

  const res = NextResponse.redirect(new URL("/", origin));
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 0,
  });
  return res;
}
