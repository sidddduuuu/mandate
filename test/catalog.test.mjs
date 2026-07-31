import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, child, output) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next exited early:\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next did not start:\n${output()}`);
}

test("tenant-bound Catalog replacement is atomic, versioned, and audited", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { alg: "RS256", kid: "catalog-test", use: "sig" });
  const jwksServer = createServer((request, response) => {
    if (request.url !== "/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  const jwksPort = await listen(jwksServer);
  t.after(() => jwksServer.close());

  const issuer = `http://127.0.0.1:${jwksPort}/`;
  const audience = "https://mandate.test/api";
  const sign = ({
    client = "supplier-a-client",
    clientId,
    org = "org_supplier_a",
    scope = "catalog:write",
    subject = "supplier-agent-a",
    expires = "5m",
    algorithm = "RS256",
  } = {}) =>
    new SignJWT({ azp: client, ...(clientId ? { client_id: clientId } : {}), org_id: org, scope })
      .setProtectedHeader({ alg: algorithm, kid: "catalog-test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(privateKey);

  const workspace = mkdtempSync(join(tmpdir(), "mandate-catalog-"));
  const databasePath = join(workspace, "mandate.sqlite");
  const port = await freePort();
  let output = "";
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        AUTH0_ISSUER_BASE_URL: issuer,
        AUTH0_AUDIENCE: audience,
        M2M_CLIENTS_JSON: JSON.stringify({
          "supplier-a-client": {
            organization_id: "supplier-a",
            actor_type: "supplier",
          },
          "supplier-b-client": {
            organization_id: "supplier-b",
            actor_type: "supplier",
          },
          "buyer-client": {
            organization_id: "buyer-a",
            actor_type: "buyer",
          },
        }),
        ORGANIZATIONS_JSON: JSON.stringify([
          {
            id: "supplier-a",
            auth0_org_id: "org_supplier_a",
            name: "Supplier A",
            kind: "supplier",
          },
          {
            id: "supplier-b",
            auth0_org_id: "org_supplier_b",
            name: "Supplier B",
            kind: "supplier",
          },
          {
            id: "buyer-a",
            auth0_org_id: "org_buyer_a",
            name: "Buyer A",
            kind: "buyer",
          },
        ]),
        REGISTERED_SKUS_JSON: JSON.stringify([
          {
            organization_id: "supplier-a",
            sku: "avocado-case",
            product_key: "produce.avocado",
            category: "produce",
            unit: "case",
          },
          {
            organization_id: "supplier-a",
            sku: "lime-case",
            product_key: "produce.lime",
            category: "produce",
            unit: "case",
          },
          {
            organization_id: "supplier-b",
            sku: "avocado-box",
            product_key: "produce.avocado",
            category: "produce",
            unit: "case",
          },
        ]),
        FIXED_NOW: "2026-07-30T20:00:00.000Z",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child, () => output);
  const request = async (token, body) => {
    const response = await fetch(`${base}/api/catalog`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  const missing = await request(undefined, { items: [] });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, "missing_bearer_token");
  assert.ok(missing.json.error.request_id);

  const wrongScope = await request(await sign({ scope: "offers:read" }), {
    items: [],
  });
  assert.equal(wrongScope.status, 403);
  assert.equal(wrongScope.json.error.code, "insufficient_scope");

  const wrongOrg = await request(await sign({ org: "org_supplier_b" }), {
    items: [],
  });
  assert.equal(wrongOrg.status, 403);
  assert.equal(wrongOrg.json.error.code, "organization_mismatch");

  const unknownClient = await request(await sign({ client: "unknown-client" }), {
    items: [],
  });
  assert.equal(unknownClient.status, 403);
  assert.equal(unknownClient.json.error.code, "unknown_client_identity");

  const ambiguousClient = await request(
    await sign({ clientId: "supplier-b-client" }),
    { items: [] },
  );
  assert.equal(ambiguousClient.status, 401);
  assert.equal(ambiguousClient.json.error.code, "ambiguous_client_identity");

  const wrongActor = await request(
    await sign({ client: "buyer-client", org: "org_buyer_a" }),
    { items: [] },
  );
  assert.equal(wrongActor.status, 403);
  assert.equal(wrongActor.json.error.code, "wrong_actor_type");

  const expired = await request(await sign({ expires: 1 }), { items: [] });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, "invalid_access_token");

  const validFrom = "2026-07-30T20:00:00.000Z";
  const validUntil = "2026-07-31T20:00:00.000Z";
  const avocado = {
    sku: "avocado-case",
    unit_price_minor: 5000,
    currency: "USD",
    advisory_quantity: 20,
    valid_from: validFrom,
    valid_until: validUntil,
    display_name: "<strong>Avocados</strong>",
    description: "A supplier string, never HTML.",
  };
  const lime = {
    ...avocado,
    sku: "lime-case",
    unit_price_minor: 2500,
    display_name: "Limes",
  };

  const tokenA = await sign();
  const first = await request(tokenA, { items: [avocado, lime] });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.changed_count, 2);
  assert.deepEqual(
    first.json.data.items.map(({ sku, active, version }) => ({ sku, active, version })),
    [
      { sku: "avocado-case", active: 1, version: 1 },
      { sku: "lime-case", active: 1, version: 1 },
    ],
  );

  const replay = await request(tokenA, { items: [avocado, lime] });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.changed_count, 0);
  assert.deepEqual(
    replay.json.data.items.map(({ version }) => version),
    [1, 1],
  );

  const unsafe = await request(tokenA, {
    items: [{ ...avocado, unit_price_minor: Number.MAX_SAFE_INTEGER + 1 }],
  });
  assert.equal(unsafe.status, 422);
  assert.equal(unsafe.json.error.code, "invalid_unit_price");

  const callerTenant = await request(tokenA, {
    organization_id: "supplier-b",
    items: [avocado],
  });
  assert.equal(callerTenant.status, 422);
  assert.equal(callerTenant.json.error.code, "invalid_catalog");

  const changed = await request(tokenA, {
    items: [{ ...avocado, unit_price_minor: 4500 }],
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.changed_count, 2);
  assert.deepEqual(
    changed.json.data.items.map(({ sku, active, version }) => ({
      sku,
      active,
      version,
    })),
    [
      { sku: "avocado-case", active: 1, version: 2 },
      { sku: "lime-case", active: 0, version: 2 },
    ],
  );

  const rollback = await request(tokenA, {
    items: [
      { ...avocado, unit_price_minor: 4000 },
      { ...lime, sku: "unknown-sku" },
    ],
  });
  assert.equal(rollback.status, 422);
  assert.equal(rollback.json.error.code, "unknown_sku");
  const afterRollback = await request(tokenA, {
    items: [{ ...avocado, unit_price_minor: 4500 }],
  });
  assert.equal(afterRollback.json.data.changed_count, 0);
  assert.equal(afterRollback.json.data.items[0].version, 2);

  const spoof = await request(tokenA, {
    items: [{ ...avocado, product_key: "allowed.fake" }],
  });
  assert.equal(spoof.status, 422);
  assert.equal(spoof.json.error.code, "unsupported_catalog_field");

  const tokenB = await sign({
    client: "supplier-b-client",
    org: "org_supplier_b",
    subject: "supplier-agent-b",
  });
  const crossTenant = await request(tokenB, { items: [avocado] });
  assert.equal(crossTenant.status, 422);
  assert.equal(crossTenant.json.error.code, "unknown_sku");

  const empty = await request(tokenA, { items: [] });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.data.items[0].active, 0);
  assert.equal(empty.json.data.items[0].version, 3);

  const db = new DatabaseSync(databasePath);
  const denials = db
    .prepare(`
      SELECT organization_id, payload_json FROM audit_events
      WHERE event_type = 'authorization.denied'
      ORDER BY id
    `)
    .all();
  assert.equal(denials.length, 7);
  assert.equal(denials[1].organization_id, "supplier-a");
  assert.throws(
    () => db.exec("UPDATE audit_events SET event_type = 'tampered'"),
    /append-only/,
  );
  assert.throws(() => db.exec("DELETE FROM audit_events"), /append-only/);
  db.close();
});
