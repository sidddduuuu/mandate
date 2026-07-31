# ADR 0003: Auth0 + Stripe integration evidence

Status: accepted (partial — Stripe live proof; Auth0 tenant pending credentials)

Date: 2026-07-30

## Context

PR #11 wires Auth0 (`@auth0/nextjs-auth0` + JWT M2M) and Stripe (PaymentIntent adapter + signed webhooks). Automated tests use `AUTH_TEST_MODE` HMAC tokens and an in-memory Stripe adapter. This ADR records what was proven against real providers in the cloud agent environment.

## Decision

### Stripe — live test-mode proof: PASS

Provisioned an ephemeral Stripe CLI sandbox (`stripe sandbox create`) and ran `npm run check:stripe` (`scripts/live-stripe-check.ts`) against Mandate's real `createStripeAdapter()`:

| Check | Result |
|---|---|
| Order awaits approval with no PaymentIntent | pass |
| Hard-denied order creates no PaymentIntent | pass |
| Approval creates one live test PaymentIntent | pass (`pi_…`, `livemode: false`) |
| Metadata `order_id`, amount, currency match | pass |
| Signed webhook via `constructEvent` marks `paid` | pass |
| Invalid signature rejected | pass |
| Webhook replay is duplicate / no re-transition | pass |
| Unrelated PaymentIntent event ignored | pass |

Also verified Stripe MCP connectivity to the user's linked Stripe account (`get_stripe_account_info` → account present). MCP can list customers/balance; PaymentIntent create is not exposed via MCP write tools, so CLI/sandbox keys are the live path for Mandate payment proof.

Stripe Projects could not provision Auth0 from the sandbox account (`ACCOUNT_NOT_ELIGIBLE`). Claim the sandbox or log into a Projects-eligible account if Auth0 provisioning via Projects is desired.

### Auth0 — live tenant proof: BLOCKED on credentials

| Check | Result |
|---|---|
| `@auth0/nextjs-auth0` + skill vendored | pass |
| Human org session mapping (`GET /api/session`) | wired; not live-exercised |
| JWKS / M2M client-credentials against a tenant | skipped — no `AUTH0_DOMAIN` in env |
| Auth0 MCP | not available in this agent session |
| Auth0 CLI | installed; device login waiting for human approval |

Issue #8 decided Auth0 Free + one confidential M2M client per org with server-owned `client_id → org` mapping. Code already supports `AUTH0_M2M_CLIENT_ORG_MAP` / DB map.

## How to finish Auth0 proof

1. Approve Auth0 CLI device login, or set in `.env` (never commit):
   - `AUTH0_DOMAIN`, `AUTH0_ISSUER`, `AUTH0_AUDIENCE`
   - `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`
   - per-org M2M clients + `AUTH0_M2M_CLIENT_ORG_MAP`
   - optional `AUTH0_BUYER_M2M_CLIENT_ID` / `AUTH0_BUYER_M2M_CLIENT_SECRET` for `npm run check:auth0`
2. Seed org rows with real Auth0 `org_…` IDs.
3. `npm run check:auth0` then browser `/auth/login?organization=org_…` → `GET /api/session`.
4. Set `AUTH_TEST_MODE=0` for demo-ready real tokens.

## Commands

```bash
# Stripe CLI sandbox (or paste sk_test_ / whsec_ into .env)
stripe sandbox create --non-interactive --email you@example.com
stripe listen --print-secret   # → STRIPE_WEBHOOK_SECRET
npm run check:stripe

# Auth0
auth0 login --no-input         # approve device code in browser
npm run check:auth0
```

## Consequences

- Stripe path is demo-credible with sandbox/test keys + CLI webhook secret.
- Auth0 remains configuration-blocked until tenant secrets exist in the environment.
- Secrets stay in `.env` / Stripe CLI config; nothing sensitive is committed.
- Full issue #23 acceptance still needs the remaining product tickets plus a real Auth0 tenant.
