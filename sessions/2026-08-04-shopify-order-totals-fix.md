# 2026-08-04 — Shopify order totals for in-stock free shipping

## Change

Ready-to-ship rates now use `rate.order_totals.subtotal_price`, the full cart subtotal Shopify includes in every carrier callback. A $76 in-stock cart split into two $38 fulfillment groups therefore returns free shipping for both groups without waiting for the callbacks to find each other.

Preorder qualification remains separate. The destination-key callback combiner remains only for preorder totals and as a fallback when Shopify omits or malforms `order_totals`.

## Why the bug looked new

The race had existed for months. Most orders used one fulfillment location or produced callbacks within the old 750 ms window. The reported cart used two warehouses, and the callbacks arrived far enough apart for the first $38 group to return a $5 rate before the second group registered.

## Validation

- `npm test`: 7 tests passed.
- Added a regression proving a lone $38 fulfillment callback returns immediately and free when Shopify reports a $76 cart subtotal.
- Kept the legacy concurrent and two-second-skew callback tests.

## Deployment

Production deploys automatically from GitHub `main`. Verify the live `/health` endpoint and run a split-rate black-box test after the deployment completes.
