import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { SignJWT } from "jose";
import { GET } from "../src/app/api/offers/route";
import {
  encodeSessionCookie,
  mintTestAgentToken,
} from "../src/auth/context";
import { closeDb } from "../src/db";
import { resetConfigCache } from "../src/lib/config";
import { setupFixture, type DemoFixture } from "./helpers";

describe("GET /api/offers", () => {
  let fx: DemoFixture;

  beforeEach(() => {
    closeDb();
    resetConfigCache();
    fx = setupFixture(`offers-${randomUUID()}`);
  });

  async function token(input?: {
    clientId?: string;
    orgId?: string;
    scope?: string;
    azp?: string;
  }) {
    return mintTestAgentToken({
      sub: "agent|buyer",
      client_id: input?.clientId ?? "buyer-client",
      org_id: input?.orgId ?? "org_buyer",
      scope: input?.scope ?? "offers:read",
      azp: input?.azp,
    });
  }

  async function discover(
    query: string,
    accessToken?: string,
    cookie?: string,
  ) {
    const response = await GET(
      new Request(`http://localhost/api/offers?${query}`, {
        headers: {
          ...(accessToken
            ? { authorization: `Bearer ${accessToken}` }
            : {}),
          ...(cookie ? { cookie } : {}),
        },
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        data?: {
          offer: {
            id: string;
            supplier_org_id: string;
            total_minor: number;
          };
        };
        error?: { code: string; request_id: string };
      },
    };
  }

  const exact =
    "product_key=avocado&unit=case&quantity=2&delivery_location_id=kitchen-1";

  it("selects the cheapest eligible Offer deterministically", async () => {
    const accessToken = await token();
    const first = await discover(exact, accessToken);
    const replay = await discover(exact, accessToken);
    assert.equal(first.status, 200);
    assert.equal(first.body.data?.offer.supplier_org_id, fx.supplierBId);
    assert.equal(first.body.data?.offer.total_minor, 7_800);
    assert.equal(replay.body.data?.offer.id, first.body.data?.offer.id);

    const events = fx.db
      .prepare(`
        SELECT payload_json FROM audit_events
        WHERE organization_id = ? AND event_type = 'offer.selected'
      `)
      .all(fx.buyerOrgId) as { payload_json: string }[];
    assert.equal(events.length, 2);
    assert.equal(
      Object.hasOwn(JSON.parse(events[0]!.payload_json), "display_description"),
      false,
    );
  });

  it("rejects tampering, malformed quantities, cookie-only auth, and scope failures", async () => {
    const accessToken = await token();
    for (const injected of [
      `organization_id=${fx.buyerOrgId}`,
      `supplier_org_id=${fx.supplierAId}`,
      "unit_price_minor=1",
      "total_minor=1",
      "currency=USD",
      "stripe_customer_id=cus_fake",
    ]) {
      assert.equal(
        (await discover(`${exact}&${injected}`, accessToken)).body.error?.code,
        "unsupported_request_field",
      );
    }
    assert.equal(
      (
        await discover(
          "product_key=avocado&unit=case&quantity=1e2&delivery_location_id=kitchen-1",
          accessToken,
        )
      ).body.error?.code,
      "invalid_offer_request",
    );
    const humanCookie = encodeSessionCookie({
      sub: "human",
      org_id: "org_buyer",
      permissions: ["orders:read"],
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    assert.equal(
      (await discover(exact, undefined, `mandate_session=${humanCookie}`)).status,
      403,
    );
    assert.equal(
      (await discover(exact, await token({ scope: "orders:read" }))).status,
      403,
    );

    const denials = fx.db
      .prepare(`
        SELECT payload_json FROM audit_events
        WHERE organization_id = ? AND event_type = 'offer.denied'
      `)
      .all(fx.buyerOrgId) as { payload_json: string }[];
    assert.ok(denials.length >= 8);
    assert.ok(
      denials.every(
        ({ payload_json }) =>
          !payload_json.includes("display_description") &&
          !payload_json.includes("Bearer "),
      ),
    );
  });

  it("binds client identity to one configured organization", async () => {
    const mismatch = await discover(
      exact,
      await token({ orgId: "org_supplier_a" }),
    );
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.error?.code, "organization_mismatch");

    const unknown = await discover(
      exact,
      await token({ clientId: "unknown-client" }),
    );
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.error?.code, "unknown_client_identity");

    const ambiguous = await discover(
      exact,
      await token({
        clientId: "buyer-client",
        azp: "supplier-a-client",
      }),
    );
    assert.equal(ambiguous.status, 401);
    assert.equal(ambiguous.body.error?.code, "ambiguous_client_identity");

    const missingClient = await discover(
      exact,
      await mintTestAgentToken({
        sub: "agent|buyer",
        org_id: "org_buyer",
        scope: "offers:read",
      }),
    );
    assert.equal(missingClient.status, 401);
    assert.equal(missingClient.body.error?.code, "missing_client_identity");

    const supplier = await discover(
      exact,
      await token({
        clientId: "supplier-a-client",
        orgId: "org_supplier_a",
      }),
    );
    assert.equal(supplier.status, 403);
    assert.equal(supplier.body.error?.code, "buyer_organization_required");
  });

  it("rejects bad signatures, algorithms, issuers, audiences, and expiry", async () => {
    const secret = new TextEncoder().encode(
      "test-hmac-secret-for-mandate-mvp-only",
    );
    const sign = (input: {
      algorithm?: "HS256" | "HS384";
      issuer?: string;
      audience?: string;
      expiry?: string;
      key?: Uint8Array;
    }) =>
      new SignJWT({
        org_id: "org_buyer",
        scope: "offers:read",
        client_id: "buyer-client",
        azp: "buyer-client",
      })
        .setProtectedHeader({ alg: input.algorithm ?? "HS256" })
        .setSubject("agent|buyer")
        .setIssuer(input.issuer ?? "https://mandate.test/")
        .setAudience(input.audience ?? "https://mandate.local/api")
        .setExpirationTime(input.expiry ?? "5m")
        .sign(input.key ?? secret);

    const invalidTokens = [
      await sign({
        key: new TextEncoder().encode(
          "different-test-key-with-enough-bytes-to-sign",
        ),
      }),
      await sign({ algorithm: "HS384" }),
      await sign({ issuer: "https://wrong.test/" }),
      await sign({ audience: "https://wrong.test/api" }),
      await sign({ expiry: "0s" }),
    ];
    for (const invalid of invalidTokens) {
      assert.equal((await discover(exact, invalid)).status, 401);
    }
  });

  it("enforces exact availability, Mandate, and Budget Window filters", async () => {
    const accessToken = await token();
    assert.equal(
      (
        await discover(
          "product_key=avocado&unit=case&quantity=101&delivery_location_id=kitchen-1",
          accessToken,
        )
      ).body.error?.code,
      "no_eligible_offer",
    );
    assert.equal(
      (
        await discover(
          "product_key=avocado&unit=case&quantity=2&delivery_location_id=other",
          accessToken,
        )
      ).body.error?.code,
      "delivery_not_allowed",
    );

    fx.db
      .prepare(`UPDATE mandates SET budget_window_end = ? WHERE status = 'active'`)
      .run(new Date(Date.now() - 1_000).toISOString());
    assert.equal(
      (await discover(exact, accessToken)).body.error?.code,
      "inactive_budget_window",
    );

    fx.db
      .prepare(`UPDATE mandates SET budget_window_end = ?, valid_until = ?`)
      .run(fx.until, new Date(Date.now() - 1_000).toISOString());
    assert.equal(
      (await discover(exact, accessToken)).body.error?.code,
      "inactive_mandate",
    );

    fx.db
      .prepare(`UPDATE mandates SET status = 'revoked', valid_until = ?`)
      .run(fx.until);
    assert.equal(
      (await discover(exact, accessToken)).body.error?.code,
      "missing_mandate",
    );
  });

  it("applies every Offer eligibility filter before returning data", async () => {
    const accessToken = await token();
    const selectedSupplier = async () =>
      (await discover(exact, accessToken)).body.data?.offer.supplier_org_id;

    fx.db
      .prepare(`UPDATE catalog_items SET active = 0 WHERE supplier_org_id = ?`)
      .run(fx.supplierBId);
    assert.equal(await selectedSupplier(), fx.supplierAId);

    fx.db
      .prepare(`
        UPDATE catalog_items SET active = 1, valid_until = ?
        WHERE supplier_org_id = ?
      `)
      .run(new Date(Date.now() - 1_000).toISOString(), fx.supplierBId);
    assert.equal(await selectedSupplier(), fx.supplierAId);

    fx.db
      .prepare(`
        UPDATE catalog_items SET valid_until = ?, category = 'disallowed'
        WHERE supplier_org_id = ?
      `)
      .run(fx.until, fx.supplierBId);
    assert.equal(await selectedSupplier(), fx.supplierAId);

    fx.db
      .prepare(`
        UPDATE catalog_items SET category = 'produce', currency = 'EUR'
        WHERE supplier_org_id = ?
      `)
      .run(fx.supplierBId);
    assert.equal(await selectedSupplier(), fx.supplierAId);

    fx.db
      .prepare(`
        UPDATE catalog_items SET currency = 'USD'
        WHERE supplier_org_id = ?
      `)
      .run(fx.supplierBId);
    fx.db
      .prepare(`
        UPDATE mandates SET allowed_supplier_org_ids_json = ?
        WHERE status = 'active'
      `)
      .run(JSON.stringify([fx.supplierAId]));
    assert.equal(await selectedSupplier(), fx.supplierAId);

    assert.equal(
      (
        await discover(
          "product_key=other&unit=case&quantity=2&delivery_location_id=kitchen-1",
          accessToken,
        )
      ).body.error?.code,
      "no_eligible_offer",
    );
    assert.equal(
      (
        await discover(
          "product_key=avocado&unit=box&quantity=2&delivery_location_id=kitchen-1",
          accessToken,
        )
      ).body.error?.code,
      "no_eligible_offer",
    );
  });

  it("uses stable supplier ID for equal-price ties and rejects unsafe totals", async () => {
    fx.db
      .prepare(`
        UPDATE catalog_items SET unit_price_minor = 4200
        WHERE supplier_org_id = ?
      `)
      .run(fx.supplierBId);
    const selected = await discover(exact, await token());
    assert.equal(
      selected.body.data?.offer.supplier_org_id,
      [fx.supplierAId, fx.supplierBId].sort()[0],
    );

    fx.db
      .prepare(`
        UPDATE catalog_items SET unit_price_minor = 10000000,
          advisory_quantity = 100000
      `)
      .run();
    const unsafe = await discover(
      "product_key=avocado&unit=case&quantity=100000&delivery_location_id=kitchen-1",
      await token(),
    );
    assert.equal(unsafe.status, 422);
    assert.equal(unsafe.body.error?.code, "unsafe_order_total");
  });
});
