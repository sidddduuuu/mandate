import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuth0Client } from "@/lib/auth0";

/**
 * Mounts Auth0 SDK routes (/auth/callback, …) and refreshes the session cookie.
 *
 * Login/logout stay on our App Router handlers so we can control organization /
 * audience params (Auth0 middleware forwards every query param to /authorize).
 */
export async function middleware(request: NextRequest) {
  const auth0 = getAuth0Client();
  if (!auth0) {
    return NextResponse.next();
  }

  const path = request.nextUrl.pathname.replace(/\/$/, "") || "/";
  if (path === "/auth/login" || path === "/auth/logout") {
    return NextResponse.next();
  }

  return auth0.middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon.ico|sitemap.xml|robots.txt|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
