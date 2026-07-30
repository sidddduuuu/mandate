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

Open `http://localhost:3000` to review the responsive Mandate experience. The
approval desk is interactive: approve the frozen purchase, confirm the
simulated signed Stripe webhook, or reject the request and inspect the audit
trail.

Run the full quality gate with:

```bash
npm run check
```
