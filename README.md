# Ship Ship Hooray

Wildwoven's Shopify carrier service for ready-to-ship and preorder rates.

## Shipping rules

- Ready-stock and preorder merchandise have independent $50 thresholds.
- Each non-qualifying stock pool costs $5 once, even when Shopify splits it across fulfillment locations.
- Hydrogen stamps preorder lines with `_shipping_bucket=preorder`; Batchy is the fallback status source for carts that lack the marker.
- The carrier callback returns a safe per-group rate. The checkout-native Function in `extensions/split-shipping-discount` performs the authoritative cross-group adjustment atomically.
- International orders defer to Shopify's native rates.

Shopify can call `/rates` once per delivery group. The carrier therefore always returns the $5 base standard rate for each physical delivery group. The Discount Function sees every group and the merchandise line subtotals in one invocation, then applies the two $50 thresholds and removes duplicate location fees. The Function can make a rate free; it never needs to reconstruct a fee the carrier already removed.

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

## Testing

```bash
npm test
npm run test:function
```

The Function must be linked to the existing Partner app before `npm run build` can compile it. See `extensions/split-shipping-discount/README.md`.
