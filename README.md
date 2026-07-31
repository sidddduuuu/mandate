# Mandate

Governed commerce for AI agents.

- [Product brief](PRODUCT.md)
- [Product mandate](MANDATE.md)
- [MVP architecture](ARCHITECTURE.md)

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` for the public Mandate landing page. The approval
workflow lives at `http://localhost:3000/dashboard` and requires an Auth0
session. Add real Auth0 tenant values to `.env.local` before testing login.

Run the full quality gate with:

```bash
npm run check
```

## Backend

Copy `.env.example` to `.env.local`, add the Neon and Auth0 values, then
initialize Postgres and optionally load the deterministic demo:

```bash
npm run db:migrate
npm run db:seed
```

The current API slice is:

| Method | Route | Authorization |
|---|---|---|
| `PUT` | `/api/catalog` | Supplier bearer token with `catalog:write` |
| `POST` | `/api/mandates` | Auth0 human session with `mandates:write` |
| `GET` | `/api/offers` | Buyer bearer token with `offers:read` |
| `POST` | `/api/orders` | Buyer bearer token with `orders:create` |
| `GET` | `/api/orders/{id}` | Buyer or supplier bearer token with `orders:read` |

Offer queries use `product_key`, `unit`, `quantity`, and
`delivery_location_id`. Order creation requires a UUID `Idempotency-Key` and
accepts only `productKey`, `unit`, `quantity`, and `deliveryLocationId`; the
server selects the offer and snapshots the policy decision. Replays return the
original result with `200` without reselecting or reevaluating. New orders
return `201`, approval requests return `202`, and requests that cannot form an
order snapshot return an idempotent denial with `422`. Supplier order reads
are limited to assigned paid orders and expose only fulfillment fields.

Every response uses the `{ data }` or sanitized
`{ error: { code, message, request_id } }` envelope.
