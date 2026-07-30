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
npm test
npm run typecheck
npm run demo
npm run dev
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

Set `AUTH_TEST_MODE=1` for local HS256 agent tokens (`mintTestAgentToken`) and signed `mandate_session` cookies.
