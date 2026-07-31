import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { encodeSessionCookie } from "@/auth/context";
import { getConfig } from "@/lib/config";

export type UiSession = {
  user: {
    sub: string;
    email?: string;
    name?: string;
    org_id?: string | null;
  };
};

export const COOKIE_NAME = "mandate_session";

export function isAuth0Configured(): boolean {
  const cfg = getConfig();
  const domain = cfg.AUTH0_DOMAIN ?? "";
  if (!domain || domain.includes("your-tenant") || domain.includes("example")) {
    return false;
  }
  return Boolean(cfg.AUTH0_CLIENT_ID && cfg.AUTH0_CLIENT_SECRET && cfg.AUTH0_SECRET);
}

export function usesLocalHumanAuth(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.AUTH_TEST_MODE) || !isAuth0Configured();
}

export function buildLocalSessionValue(input: {
  sub?: string;
  orgId: string;
}): string {
  const permissions = getConfig()
    .AUTH0_DEFAULT_HUMAN_PERMISSIONS.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return encodeSessionCookie({
    sub: input.sub ?? "human-approver@mandate.local",
    org_id: input.orgId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
  });
}

export function readLocalSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
): UiSession | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)mandate_session=([^;]+)/);
  if (!match?.[1]) return null;
  const cfg = getConfig();
  const secret = cfg.SESSION_SECRET ?? cfg.AUTH_TEST_HMAC_SECRET;
  const raw = decodeURIComponent(match[1]);
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sub?: string;
      org_id?: string;
      exp?: number;
    };
    if (!payload.sub || !payload.org_id) return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return {
      user: {
        sub: payload.sub,
        email: payload.sub.includes("@") ? payload.sub : `${payload.sub}@mandate.local`,
        name: "Local Approver",
        org_id: payload.org_id,
      },
    };
  } catch {
    return null;
  }
}

export async function readLocalSession(): Promise<UiSession | null> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (!value) return null;
  return readLocalSessionFromCookieHeader(`${COOKIE_NAME}=${encodeURIComponent(value)}`);
}
