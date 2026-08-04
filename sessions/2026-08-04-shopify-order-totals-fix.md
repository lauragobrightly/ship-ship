# 2026-08-04 — Exact split-shipping design

## Change

The earlier patch treated `rate.order_totals.subtotal_price` as ready-stock merchandise. That is incorrect for mixed carts: it is the whole-cart subtotal, so $30 ready stock plus a $60 preorder could make both shipments free.

The final design removes threshold decisions from the carrier callback. It always returns the $5 base standard rate for each delivery group. This is the only safe direction because a Discount Function can reduce a shipping rate but cannot add back a fee that the carrier made free from incomplete or pre-discount data.

A new Shopify Shipping Discount Function is the authoritative checkout step. It receives every delivery group atomically, classifies groups from `PO_STD`/`RTS_STD` with the private line marker as a conflict guard, totals post-discount merchandise values separately, and adjusts only Ship Ship Hooray's standard options:

- qualifying pools: all groups free;
- non-qualifying pools: one $5 group, with duplicate location fees removed;
- express and unrelated rates: untouched;
- mixed-promise delivery group: unchanged and treated as a launch-test failure.

## Why the bug looked new

The race had existed for months. Carrier callbacks are separate requests and Shopify can impose a three-second deadline. No in-memory wait can guarantee that sibling delivery groups arrive before the first response is due. The Function removes that timing dependency because Shopify passes all delivery groups to one invocation.

## Validation

- Carrier suite: 17/17 tests passed.
- Function suite: 32/32 tests passed, plus 441 exhaustive threshold/location
  combinations enforcing one fee per non-qualifying pool.
- Covered exact boundaries, two independent pools, one-to-three locations,
  post-discount totals, presentment currency, legacy carts, service-code/title
  fallbacks, Batchy outage behavior, duplicate variants, zero-value items,
  express/unrelated rates, malformed input, and ambiguous mixed groups.
- The input query validates against Shopify's official 2026-07 Function schema,
  and Shopify CLI compiled the JavaScript Function to Wasm successfully.
- Shopify's Wasm runner passed a production-shaped regression fixture matching
  the reported checkout: two ready-stock groups at $38 each both receive a 100%
  shipping discount.

## Deployment

Production deploys automatically from GitHub `main`. Safe rollout order:

1. Link the existing Partner app and add `write_discounts`. Completed.
2. Build and deploy the Function. Released as app version
   `split-shipping-2026-08-04` on 2026-08-04.
3. Activate it as an automatic shipping discount.
4. Deploy the carrier patch.
5. Run the full real-checkout matrix before opening Jimothy.
