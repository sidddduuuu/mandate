/**
 * Reports Auth0 + Stripe readiness for this workspace.
 */
import { getAuth0Client } from "../src/lib/auth0";
import { getConfig, resetConfigCache } from "../src/lib/config";

resetConfigCache();
const cfg = getConfig();
const auth0 = getAuth0Client();

const report = {
  auth0: {
    sdk_configured: Boolean(auth0),
    domain_set: Boolean(cfg.AUTH0_DOMAIN && !cfg.AUTH0_DOMAIN.includes("your-tenant")),
    client_id_set: Boolean(cfg.AUTH0_CLIENT_ID),
    client_secret_set: Boolean(cfg.AUTH0_CLIENT_SECRET),
    secret_set: Boolean(cfg.AUTH0_SECRET),
    audience_set: Boolean(cfg.AUTH0_AUDIENCE),
    test_mode: Boolean(cfg.AUTH_TEST_MODE),
    note: auth0
      ? "SDK client constructed. Browser login still needs a real Auth0 tenant + Organizations."
      : "Missing AUTH0_DOMAIN / CLIENT_ID / CLIENT_SECRET / AUTH0_SECRET — human Org login inactive.",
  },
  stripe: {
    secret_set: Boolean(cfg.STRIPE_SECRET_KEY),
    test_key: Boolean(cfg.STRIPE_SECRET_KEY?.startsWith("sk_test_")),
    live_key: Boolean(cfg.STRIPE_SECRET_KEY?.startsWith("sk_live_")),
    webhook_secret_set: Boolean(cfg.STRIPE_WEBHOOK_SECRET),
    note: !cfg.STRIPE_SECRET_KEY
      ? "No STRIPE_SECRET_KEY in env. Stripe MCP may be connected separately; app PaymentIntents need sk_test_."
      : cfg.STRIPE_SECRET_KEY.startsWith("sk_test_")
        ? "Test key present — run: npx tsx scripts/live-stripe-smoke.ts"
        : "Non-test key present — Mandate MVP must use Stripe test mode only.",
  },
};

console.log(JSON.stringify(report, null, 2));
