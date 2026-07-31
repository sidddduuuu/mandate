import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME } from "@/lib/local-session";

export const runtime = "nodejs";

/** Clears the local demo session cookie. Auth0 SDK logout is handled by middleware when configured. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const origin =
    host && !host.startsWith("0.0.0.0")
      ? `${proto}://${host}`
      : getConfig().APP_BASE_URL || url.origin;
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
