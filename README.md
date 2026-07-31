# Mandate

Governed commerce for AI agents.

- [Product mandate](MANDATE.md)
- [MVP architecture](ARCHITECTURE.md)

## Run locally

Use Node 26+, copy `.env.example` to `.env.local`, supply the Auth0 and
server-owned tenant seed values, then run:

```sh
npm install
npm run dev
```

The supplier Catalog endpoint is `PUT /api/catalog`. Verify the complete
foundation with `npm run check`; the system test uses local JWT/JWKS fixtures
and a temporary SQLite database.
