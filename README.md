# Ship Ship Hooray

Wildwoven's Shopify carrier service for ready-to-ship and preorder rates.

## Shipping rules

- Hydrogen signs the post-discount ready-stock and preorder pool totals before
  checkout. Every line carries its pool total, and one line per pool is the fee
  anchor.
- Ship Ship Hooray verifies those signatures with the shared Batchy credential.
  Pools at or above $50 are free. Below $50, only the group containing the
  signed anchor costs $5, even when Shopify splits the pool across locations.
- Ready-stock and preorder pools always qualify independently. The virtual
  Pre-Order Warehouse remains the fulfillment boundary.
- Missing, stale, conflicting, or modified signed data fails closed at $5.
- International orders defer to Shopify's native rates.

Shopify can call `/rates` once per fulfillment group. A callback cannot see its
sibling groups, so it cannot reconstruct either stock pool reliably. The signed
quote supplies that missing cart-wide context without waiting for sibling
callbacks. Legacy carts retain the prior conservative fallback until they pass
through Hydrogen's `/checkout` bridge.

## Production

- Host: Railway service `ship-ship` in project `brilliant-elegance`
- URL: `https://ship-ship-production.up.railway.app`
- Deployment: GitHub auto-deploy from `main`
- Cache: in-process TTL cache

## Required environment variables

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_ACCESS_TOKEN`
- `SHOPIFY_SHOP_DOMAIN`
- `APP_DOMAIN`
- `BATCHY_API_KEY`
- `BATCHY_URL`

`BATCHY_API_KEY` must match Hydrogen's production value because it also signs
and verifies the private shipping quote. `CROSS_GROUP_WINDOW_MS` is optional and
applies only to legacy carts without signed data.

## Testing

```bash
npm test
```

The suite includes the reported two-location $76 checkout, independent mixed
pools, tamper/staleness guards, object-form properties, and 441 ready/preorder
threshold × location combinations.
