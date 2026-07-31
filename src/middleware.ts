import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuth0Client } from "@/lib/auth0";

/**
 * Mounts Auth0 SDK routes (/auth/login, /auth/callback, /auth/logout, …)
 * and refreshes the encrypted session cookie.
 *
 * Agent bearer APIs still authenticate in Node route handlers; this middleware
 * only provides the human Organization login session path.
 */
export async function middleware(request: NextRequest) {
  const auth0 = getAuth0Client();
  if (!auth0?.middleware) {
    return NextResponse.next();
  }
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
