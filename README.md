# Mandate

Governed commerce for AI agents.

- [Product mandate](MANDATE.md)
- [MVP architecture](ARCHITECTURE.md)
- [MVP backend decisions](docs/adr/0001-mvp-backend-decisions.md)

## Backend (this repo)

Single Next.js (Node runtime) app with SQLite. Agent and human JSON APIs live under `/api/*`.

```bash
cp .env.example .env
npm install
npm run db:init
npm run seed
npm run seed:demo   # optional: mandate + awaiting_approval order for the UI
npm test
npm run typecheck
npm run demo
# Dev on :3001 (keep APP_BASE_URL in sync)
npm run dev -- -H 0.0.0.0 -p 3001
```

### API surface

| Method | Route | Auth |
|---|---|---|
| `POST` | `/api/mandates` | Human session + CSRF |
| `POST` | `/api/mandates/revoke` | Human session + CSRF |
| `PUT` | `/api/catalog` | Supplier agent bearer |
| `GET` | `/api/offers` | Buyer agent bearer |
| `POST` | `/api/orders` | Buyer agent bearer + `Idempotency-Key` |
| `GET` | `/api/orders/:id` | Buyer/supplier/human |
| `POST` | `/api/orders/:id/approval` | Human session + CSRF |
| `POST` | `/api/orders/:id/abandon` | Human session + CSRF |
| `GET` | `/api/approvals` | Human session |
| `GET` | `/api/audit` | Human session |
| `POST` | `/api/webhooks/stripe` | Stripe signature |

### Auth0 (human Organizations session)

This repo uses the official Auth0 agent skill (`.agents/skills/auth0`) and
`@auth0/nextjs-auth0` v4 for human approvers:

1. Configure `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL`.
2. In the Auth0 app, allow `{APP_BASE_URL}/auth/callback` and enable Organizations.
3. Open `/auth/login?organization=org_…` (home page links the seeded buyer org).
4. Call `GET /api/session` — Mandate maps the Auth0 `org_id` + permissions into the human actor used by approvals/mandates.

Agent M2M stays on bearer JWTs (`AUTH0_AUDIENCE` + JWKS). With `AUTH_TEST_MODE=1` (default in `.env.example`) or empty Auth0 client credentials, `/auth/login` sets a local `mandate_session` cookie so the UI works without a tenant. Approvals in that mode settle PaymentIntents in-process (in-memory Stripe) so orders reach `paid` without `stripe listen`.

### Human UI

Verae-inspired product surface (warm editorial landing + approver workspace):

- `/` — marketing / product page
- `/approvals` — pending human decisions
- `/orders` · `/orders/[id]` — history and approve/reject
- `/mandates` — publish a mandate version
- `/audit` — organization audit trail

### Provider checks

```bash
# Real Stripe test/sandbox keys in .env (+ webhook secret from stripe listen)
npm run check:stripe

# Auth0 tenant env (skipped cleanly if AUTH0_DOMAIN unset)
npm run check:auth0
```

Evidence and remaining Auth0 credential steps: [docs/adr/0003-auth0-stripe-integration-evidence.md](docs/adr/0003-auth0-stripe-integration-evidence.md).
