import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { SignJWT } from "jose";
import { closeDb } from "../src/db";
import { resetConfigCache } from "../src/lib/config";
import { resetAuth0Client, setAuth0ClientForTests } from "../src/lib/auth0";
import {
  authenticateRequest,
  encodeSessionCookie,
} from "../src/auth/context";
import {
  createOrder,
  decideApproval,
  handleStripeWebhook,
} from "../src/procurement/orders";
import { setupFixture, type DemoFixture } from "./helpers";
import { GET as listApprovalRoute } from "../src/app/api/approvals/route";
import { POST as decideApprovalRoute } from "../src/app/api/orders/[id]/approval/route";
import { setStripeOverride } from "../src/lib/api";

describe("Auth0 session + Stripe payment integration", () => {
  let fx: DemoFixture;

  beforeEach(() => {
    closeDb();
    resetAuth0Client();
    resetConfigCache();
    fx = setupFixture(`auth0-stripe-${randomUUID()}`);
  });

  afterEach(() => {
    setStripeOverride(null);
    setAuth0ClientForTests(undefined);
    resetAuth0Client();
  });

  it("maps an Auth0 Organization session into a human actor and completes Stripe payment", async () => {
    const accessToken = await new SignJWT({
      org_id: "org_buyer",
      permissions: ["approvals:decide", "approvals:read", "orders:read", "mandates:write"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("auth0|approver-1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-verified-in-decodeJwt"));

    setAuth0ClientForTests({
      async getSession() {
        return {
          user: {
            sub: "auth0|approver-1",
            email: "approver@restaurant.test",
            org_id: "org_buyer",
          },
          tokenSet: {
            accessToken,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          internal: {
            sid: "sid_test",
            createdAt: Math.floor(Date.now() / 1000),
          },
        };
      },
    });

    const actor = await authenticateRequest(
      fx.db,
      new Request("http://localhost/api/approvals", {
        headers: { cookie: "__session=unused" },
      }),
      "auth0-1",
    );

    assert.equal(actor.actorType, "human");
    assert.equal(actor.subject, "auth0|approver-1");
    assert.equal(actor.organizationId, fx.buyerOrgId);
    assert.equal(actor.auth0OrgId, "org_buyer");
    assert.ok(actor.permissions.has("approvals:decide"));

    const { order, httpStatus } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "order-1",
      fx.stripe,
    );
    assert.equal(httpStatus, 202);
    assert.equal(order.status, "awaiting_approval");
    assert.equal(fx.stripe.intents.size, 0);

    const approved = await decideApproval(
      fx.db,
      actor,
      order.id,
      { decision: "approve", reason: "Auth0 org approver" },
      "approve-1",
      fx.stripe,
    );
    assert.equal(approved.status, "payment_pending");
    assert.ok(approved.stripe_payment_intent_id);
    assert.equal(fx.stripe.intents.size, 1);

    const pi = fx.stripe.intents.get(approved.stripe_payment_intent_id!)!;
    assert.equal(pi.amount, approved.total_minor);
    assert.equal(pi.currency, "usd");
    assert.equal(pi.metadata.order_id, approved.id);

    const eventBody = {
      id: "evt_auth0_stripe_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: pi.id,
          amount: pi.amount,
          currency: "usd",
          metadata: { order_id: approved.id },
        },
      },
    };
    const constructed = fx.stripe.constructEvent(
      JSON.stringify(eventBody),
      "test_sig",
    ) as unknown as typeof eventBody;
    handleStripeWebhook(fx.db, constructed, "wh-1");

    const paid = fx.db
      .prepare(`SELECT status, approval_actor_subject FROM orders WHERE id = ?`)
      .get(order.id) as { status: string; approval_actor_subject: string };
    assert.equal(paid.status, "paid");
    assert.equal(paid.approval_actor_subject, "auth0|approver-1");
  });

  it("rejects Auth0 sessions without organization context", async () => {
    setAuth0ClientForTests({
      async getSession() {
        return {
          user: { sub: "auth0|no-org", email: "x@test.com" },
          tokenSet: {
            accessToken: "opaque",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          internal: { sid: "s", createdAt: Math.floor(Date.now() / 1000) },
        };
      },
    });

    await assert.rejects(
      () =>
        authenticateRequest(
          fx.db,
          new Request("http://localhost/api/session"),
          "auth0-2",
        ),
      (err: unknown) =>
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "missing_organization",
    );
  });

  it("mints Auth0-shaped agent tokens and keeps Stripe out of hard denials", async () => {
    const { mintTestAgentToken } = await import("../src/auth/context");
    const token = await mintTestAgentToken({
      sub: "agent|buyer",
      org_id: "org_buyer",
      scope: "orders:create orders:read",
      client_id: "buyer-client",
    });

    const agent = await authenticateRequest(
      fx.db,
      new Request("http://localhost/api/orders", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      "agent-1",
    );
    assert.equal(agent.actorType, "agent");
    assert.equal(agent.organizationId, fx.buyerOrgId);

    const { order } = await createOrder(
      fx.db,
      agent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 20,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "deny-stripe",
      fx.stripe,
    );
    assert.equal(order.status, "denied");
    assert.equal(order.stripe_payment_intent_id, null);
    assert.equal(fx.stripe.intents.size, 0);
  });

  it("enforces approval tenant, permission, and CSRF boundaries at the routes", async () => {
    setAuth0ClientForTests(null);
    setStripeOverride(fx.stripe);
    const { order } = await createOrder(
      fx.db,
      fx.buyerAgent,
      {
        product_key: "avocado",
        unit: "case",
        quantity: 2,
        delivery_location_id: "kitchen-1",
      },
      randomUUID(),
      "approval-route-order",
      fx.stripe,
    );
    const cookie = (orgId: string, permissions: string[]) =>
      `mandate_session=${encodeSessionCookie({
        sub: "human-route-approver",
        org_id: orgId,
        permissions,
        exp: Math.floor(Date.now() / 1000) + 300,
      })}`;

    const buyerList = await listApprovalRoute(
      new Request("http://localhost/api/approvals", {
        headers: { cookie: cookie("org_buyer", ["approvals:read"]) },
      }),
    );
    assert.equal(buyerList.status, 200);
    const buyerBody = (await buyerList.json()) as {
      data: { approvals: { id: string }[] };
    };
    assert.deepEqual(
      buyerBody.data.approvals.map((approval) => approval.id),
      [order.id],
    );

    const otherList = await listApprovalRoute(
      new Request("http://localhost/api/approvals", {
        headers: { cookie: cookie("org_supplier_a", ["approvals:read"]) },
      }),
    );
    assert.deepEqual(
      ((await otherList.json()) as { data: { approvals: unknown[] } }).data
        .approvals,
      [],
    );

    const context = { params: Promise.resolve({ id: order.id }) };
    const noCsrf = await decideApprovalRoute(
      new Request(`http://localhost/api/orders/${order.id}/approval`, {
        method: "POST",
        headers: {
          cookie: cookie("org_buyer", ["approvals:decide"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      context,
    );
    assert.equal(noCsrf.status, 403);

    const noPermission = await decideApprovalRoute(
      new Request(`http://localhost/api/orders/${order.id}/approval`, {
        method: "POST",
        headers: {
          cookie: cookie("org_buyer", ["approvals:read"]),
          "content-type": "application/json",
          "x-csrf-token": "mandate",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      context,
    );
    assert.equal(noPermission.status, 403);

    const approved = await decideApprovalRoute(
      new Request(`http://localhost/api/orders/${order.id}/approval`, {
        method: "POST",
        headers: {
          cookie: cookie("org_buyer", ["approvals:decide"]),
          "content-type": "application/json",
          "x-csrf-token": "mandate",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      context,
    );
    assert.equal(approved.status, 200);
    assert.equal(
      ((await approved.json()) as { data: { status: string } }).data.status,
      "payment_pending",
    );
  });
});
