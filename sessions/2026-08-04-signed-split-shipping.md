# 2026-08-04 — Signed split-shipping fix

## Root cause

Shopify invokes app-calculated carrier rates once per delivery group. The old
service tried to infer a whole stock pool from separate callbacks that could
arrive seconds apart. The race existed for months and surfaced more often when
checkout split ready-stock items across fulfillment locations.

The first attempted replacement used a Shopify Shipping Discount Function.
Its code and Wasm tests passed, but Shopify rejected live activation because
Wildwoven is not on Plus and the Function belongs to a custom app.

## Standard-plan design

Hydrogen now signs each ready-stock and preorder pool before redirecting to
checkout. Each physical line contains:

- the post-discount pool subtotal;
- the full cart subtotal and currency;
- a cart-specific quote ID;
- one anchor flag per pool;
- an HMAC bound to product, variant, quantity, bucket, totals, and anchor flag.

The carrier verifies every field against Shopify's callback and the shared
Batchy credential. A pool at $50 or more is free. Below $50, only the delivery
group containing the signed anchor line costs $5. Invalid or stale data fails
closed.

Shopify documents that split-shipping checkout does not split a single cart
line across locations, so the anchor belongs to exactly one delivery group.

## Validation

- Carrier suites: 24/24 tests pass.
- Hydrogen quote suite: 9/9 tests pass.
- Exhaustive carrier invariant: 441 ready/preorder threshold × location cases.
- Cross-runtime Web Crypto/Node HMAC fixture matches byte-for-byte.
- Hydrogen typecheck and production build pass.
- Existing CSS parser warning and missing local ESLint executable are unrelated
  pre-existing project issues.

## Rollout order

1. Deploy Hydrogen quote producer and `/checkout` bridge.
2. Verify production cart lines carry signed private attributes.
3. Deploy the carrier verifier.
4. Test ready-stock, preorder, mixed, boundary, and multi-location checkouts.
