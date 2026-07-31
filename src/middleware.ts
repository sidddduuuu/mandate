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
  if (!auth0) {
    return NextResponse.next();
  }
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    /*
     * Run Auth0 middleware on app routes, but skip Next internals and
     * common static assets so error/404 prerender stays clean.
     */
    "/((?!_next/static|_next/image|_next/data|favicon.ico|sitemap.xml|robots.txt|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
