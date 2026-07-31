import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_PATH: z.string().default("./data/mandate.db"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  MAX_ORDER_TOTAL_MINOR: z.coerce.number().int().positive().default(100_000_000),
  MAX_UNIT_PRICE_MINOR: z.coerce.number().int().positive().default(10_000_000),
  MAX_QUANTITY: z.coerce.number().int().positive().default(100_000),
  AUTH0_DOMAIN: z.string().min(1).optional(),
  AUTH0_AUDIENCE: z.string().min(1).optional(),
  AUTH0_ISSUER: z.string().url().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_CLIENT_SECRET: z.string().optional(),
  /** Cookie encryption secret for @auth0/nextjs-auth0 (openssl rand -hex 32). */
  AUTH0_SECRET: z.string().min(32).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  AUTH0_M2M_CLIENT_ORG_MAP: z.string().optional(),
  /**
   * Fallback human permissions when the access token has no RBAC `permissions`
   * claim (comma-separated). Prefer Auth0 API Authorization + org roles in prod.
   */
  AUTH0_DEFAULT_HUMAN_PERMISSIONS: z
    .string()
    .default("mandates:write,approvals:read,approvals:decide,orders:read"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_DEFAULT_PAYMENT_METHOD: z.string().default("pm_card_visa"),
  /** Test-only: skip remote JWKS and trust locally signed HS256 tokens. */
  AUTH_TEST_MODE: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  AUTH_TEST_HMAC_SECRET: z.string().default("test-hmac-secret-for-mandate-mvp-only"),
});

export type AppConfig = z.infer<typeof envSchema> & {
  m2mClientOrgMap: Record<string, string>;
};

let cached: AppConfig | null = null;

function parseM2mMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const clientId = trimmed.slice(0, eq).trim();
    const orgId = trimmed.slice(eq + 1).trim();
    if (clientId && orgId) out[clientId] = orgId;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    m2mClientOrgMap: parseM2mMap(parsed.AUTH0_M2M_CLIENT_ORG_MAP),
  };
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
