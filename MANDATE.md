# Mandate

> Governed commerce for AI agents.

Mandate is an agent-to-agent B2B procurement platform that lets autonomous buyers discover suppliers, place orders, and pay—within rules set by the business they represent.

## The problem

AI agents can find products and call checkout APIs, but businesses cannot safely give them unrestricted purchasing power. An agent must prove:

- which organization it represents;
- what it is allowed to buy;
- which suppliers it may use;
- how much it may spend; and
- when a human must approve an exception.

## The solution

Mandate gives every buying agent a verifiable purchasing mandate: a scoped set of permissions, budgets, supplier restrictions, delivery requirements, and approval rules.

Supplier agents publish normalized catalogs. Buyer agents authenticate, compare eligible offers, create orders, and pay. Transactions outside policy pause for human approval, while every decision remains auditable.

## Demo

1. A produce supplier publishes its inventory as a normalized catalog.
2. A restaurant inventory agent detects that avocados are running low.
3. The agent authenticates as the restaurant through Auth0.
4. Mandate verifies its purchasing policy and compares approved suppliers.
5. An over-budget order triggers human approval.
6. Stripe processes the approved payment.
7. A Stripe CLI webhook confirms the order and updates the audit trail.

## Hackathon stack

- **Auth0:** agent identity, organization membership, scoped authorization, and human approval.
- **Stripe:** payment collection and transaction lifecycle.
- **Stripe CLI:** local webhook forwarding and payment-event testing.

## Pitch

**Mandate is the trust and transaction layer for agent-to-agent commerce—giving every AI buyer the authority to act without giving it unlimited authority.**
