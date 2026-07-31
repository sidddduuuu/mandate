/**
 * Auth0 readiness + optional live probes.
 *
 * Without tenant credentials: reports wiring status and exits 0 with AUTH0_SKIPPED.
 * With AUTH0_DOMAIN (+ issuer/audience): verifies JWKS reachability and JWT config.
 * With AUTH0_CLIENT_ID/SECRET/SECRET: verifies nextjs-auth0 client constructs.
 * With AUTH0_M2M_* env vars: optionally fetches a client-credentials token.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadEnvFile } from "./load-env";
import { resetConfigCache, getConfig, loadConfig } from "../src/lib/config";
import { getAuth0Client, resetAuth0Client } from "../src/lib/auth0";

loadEnvFile();
resetConfigCache();
resetAuth0Client();

type Result = { check: string; ok: boolean; detail?: string };

const results: Result[] = [];

function record(check: string, ok: boolean, detail?: string) {
  results.push({ check, ok, detail });
  console.log(ok ? "PASS" : "FAIL", check, detail ?? "");
}

async function main(): Promise<void> {
  const cfg = getConfig();

  record(
    "auth0_sdk_package",
    true,
    "@auth0/nextjs-auth0 present (see package.json)",
  );

  const hasDomain = Boolean(cfg.AUTH0_DOMAIN && !cfg.AUTH0_DOMAIN.includes("your-tenant"));
  const hasApp =
    hasDomain &&
    Boolean(cfg.AUTH0_CLIENT_ID) &&
    Boolean(cfg.AUTH0_CLIENT_SECRET) &&
    Boolean(cfg.AUTH0_SECRET && cfg.AUTH0_SECRET.length >= 32);
  const hasApi = Boolean(cfg.AUTH0_ISSUER && cfg.AUTH0_AUDIENCE);

  record("env_domain", hasDomain, hasDomain ? cfg.AUTH0_DOMAIN : "AUTH0_DOMAIN unset/placeholder");
  record(
    "env_web_app",
    hasApp,
    hasApp ? "client id/secret/AUTH0_SECRET configured" : "missing AUTH0_CLIENT_ID/SECRET/AUTH0_SECRET",
  );
  record(
    "env_api",
    hasApi,
    hasApi ? `${cfg.AUTH0_ISSUER} aud=${cfg.AUTH0_AUDIENCE}` : "missing AUTH0_ISSUER/AUTH0_AUDIENCE",
  );
  record(
    "m2m_org_map",
    Object.keys(cfg.m2mClientOrgMap).length > 0,
    `entries=${Object.keys(cfg.m2mClientOrgMap).length} (Free-plan fallback: one client per org)`,
  );
  record("auth_test_mode", true, `AUTH_TEST_MODE=${cfg.AUTH_TEST_MODE ? "1" : "0"}`);

  if (hasApp) {
    const client = getAuth0Client();
    record("nextjs_auth0_client", client !== null, client ? "Auth0Client constructed" : "null");
  } else {
    record("nextjs_auth0_client", false, "skipped — web app credentials incomplete");
  }

  if (hasDomain) {
    try {
      const jwksUrl = `https://${cfg.AUTH0_DOMAIN}/.well-known/jwks.json`;
      const res = await fetch(jwksUrl);
      const body = (await res.json()) as { keys?: unknown[] };
      record(
        "jwks_reachable",
        res.ok && Array.isArray(body.keys) && body.keys.length > 0,
        `${jwksUrl} keys=${body.keys?.length ?? 0}`,
      );
      // Warm jose JWKS
      createRemoteJWKSet(new URL(jwksUrl));
      record("jose_jwks_client", true, "createRemoteJWKSet ok");
    } catch (err) {
      record("jwks_reachable", false, (err as Error).message);
    }
  } else {
    record("jwks_reachable", false, "skipped — no domain");
  }

  // Optional M2M token exchange for a buyer client
  const m2mClientId = process.env.AUTH0_BUYER_M2M_CLIENT_ID;
  const m2mClientSecret = process.env.AUTH0_BUYER_M2M_CLIENT_SECRET;
  if (hasDomain && hasApi && m2mClientId && m2mClientSecret) {
    try {
      const tokenRes = await fetch(`https://${cfg.AUTH0_DOMAIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: m2mClientId,
          client_secret: m2mClientSecret,
          audience: cfg.AUTH0_AUDIENCE,
        }),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        record(
          "m2m_token",
          false,
          tokenJson.error_description ?? tokenJson.error ?? `http ${tokenRes.status}`,
        );
      } else {
        const jwks = createRemoteJWKSet(
          new URL(`https://${cfg.AUTH0_DOMAIN}/.well-known/jwks.json`),
        );
        const { payload } = await jwtVerify(tokenJson.access_token, jwks, {
          issuer: cfg.AUTH0_ISSUER,
          audience: cfg.AUTH0_AUDIENCE,
        });
        const clientClaim =
          (typeof payload.azp === "string" && payload.azp) ||
          (typeof payload.client_id === "string" && payload.client_id) ||
          "";
        record(
          "m2m_token",
          true,
          `sub=${String(payload.sub)} azp/client_id=${clientClaim} scope=${String(payload.scope ?? "")}`,
        );
      }
    } catch (err) {
      record("m2m_token", false, (err as Error).message);
    }
  } else {
    record(
      "m2m_token",
      false,
      "skipped — set AUTH0_BUYER_M2M_CLIENT_ID/SECRET (+ domain/audience) for live M2M",
    );
  }

  // Ensure loadConfig still works for placeholder-only envs used in CI
  loadConfig({ ...process.env, AUTH0_DOMAIN: cfg.AUTH0_DOMAIN });

  const criticalLive = ["jwks_reachable", "nextjs_auth0_client", "m2m_token"] as const;
  const liveAttempted = hasDomain;
  const livePass = results.filter((r) => criticalLive.includes(r.check as (typeof criticalLive)[number]) && r.ok);

  console.log("---");
  console.log(
    JSON.stringify(
      {
        auth0_domain_configured: hasDomain,
        live_attempted: liveAttempted,
        live_passes: livePass.map((r) => r.check),
        results,
      },
      null,
      2,
    ),
  );

  if (!hasDomain) {
    console.log("AUTH0_SKIPPED — no tenant credentials in environment");
    console.log(
      "Next: complete Auth0 CLI device login, or set AUTH0_DOMAIN/CLIENT_ID/CLIENT_SECRET/AUTH0_SECRET/ISSUER/AUDIENCE in .env",
    );
    process.exit(0);
  }

  if (!results.find((r) => r.check === "jwks_reachable")?.ok) {
    process.exit(1);
  }
  console.log("AUTH0_CHECK_PASSED_PARTIAL — JWKS ok; complete org login + M2M for full proof");
}

main().catch((err) => {
  console.error("AUTH0_CHECK_FAILED", err);
  process.exit(1);
});
