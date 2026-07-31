type Organization = {
  id: string;
  auth0_org_id: string;
  name: string;
  kind: "buyer" | "supplier";
};

type Client = {
  organization_id: string;
  actor_type: "buyer" | "supplier";
};

type RegisteredSku = {
  organization_id: string;
  sku: string;
  product_key: string;
  category: string;
  unit: string;
};

export type Config = {
  databasePath: string;
  issuer: string;
  audience: string;
  clients: Record<string, Client>;
  organizations: Organization[];
  registeredSkus: RegisteredSku[];
};

let cached: Config | undefined;

function json<T>(name: string): T {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

export function getConfig(): Config {
  if (cached) return cached;
  const issuer = process.env.AUTH0_ISSUER_BASE_URL;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!issuer || !audience) throw new Error("Auth0 issuer and audience are required");
  const issuerUrl = new URL(issuer);
  if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";

  cached = {
    databasePath: process.env.DATABASE_PATH || ".data/mandate.sqlite",
    issuer: issuerUrl.toString(),
    audience,
    clients: json<Record<string, Client>>("M2M_CLIENTS_JSON"),
    organizations: json<Organization[]>("ORGANIZATIONS_JSON"),
    registeredSkus: json<RegisteredSku[]>("REGISTERED_SKUS_JSON"),
  };
  return cached;
}
