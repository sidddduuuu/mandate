# ADR 0001: MVP backend decisions for open grilling questions

## Status

Accepted for hackathon MVP backend implementation.

## Context

Several product questions in GitHub issues #2–#7 and #9 were unresolved. Backend
implementation requires explicit defaults.

## Decisions

1. **Catalog updates (#2):** `PUT /api/catalog` updates only listed registered SKUs.
   Omitted SKUs remain unchanged. Unknown SKUs are rejected. Empty `items` is a no-op.
2. **Future-dated mandates (#3):** Reject create if `valid_from` is in the future.
3. **Approval staleness (#4):** Invalidate when catalog `version` differs from the
   order snapshot, or when active/price/currency/validity/advisory quantity no longer
   satisfy the order.
4. **Approval expiry (#5):** Fixed system TTL via `APPROVAL_TTL_SECONDS` (default 24h),
   starting at order creation. Expiry transitions `awaiting_approval` → `expired` and
   releases budget reservation.
5. **Mandate revocation (#6):** Supported. Active mandate becomes `revoked`;
   `awaiting_approval` orders for that mandate become `stale`. In-flight payments continue.
6. **Failed-payment abandonment (#7):** A human with `approvals:decide` may abandon a
   `payment_failed` order; Mandate cancels the PaymentIntent, then marks `cancelled`.
7. **Budget continuity (#9):** Committed spend is summed for the buyer organization over
   the *active* mandate's budget window across reserving order statuses, regardless of
   which mandate version created each order.

## Consequences

Frontend and later product reviews may supersede these defaults; update this ADR and tests together.
