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
- Honest stale or missing quote data fails customer-safe at $0 because a single
  callback cannot know whether another warehouse holds the rest of its pool.
  Invalid HMACs and other malformed/tamper-shaped data fail customer-safe at
  $0 and alert. This bridge prioritizes never charging a customer for a
  warehouse split; the future Shopify Function restores exact enforcement.
- If Shopify divides the fee-anchor line itself between warehouses, no partial
  callback charges it. Hydrogen prefers a quantity-1 anchor to avoid that case.
- Every customer-safe $0 fallback sends an immediate warning through Collie to
  Slack. Identical quote/reason alerts are deduplicated for 15 minutes.
- International orders defer to Shopify's native rates.

Shopify can call `/rates` once per fulfillment group. A callback cannot see its
sibling groups, so it cannot reconstruct either stock pool reliably. The signed
quote supplies that missing cart-wide context without waiting for sibling
callbacks. Hydrogen's `/checkout` bridge refreshes every quote synchronously.
Accelerated or legacy carts that bypass the bridge receive the customer-safe $0
fallback; that is deliberate undercharging, never per-warehouse overcharging.
This fallback is an incident guard, not exact business-rule coverage. Shop and
the direct PDP Shop Pay button bypass the bridge, and an under-$50 RTS cart can
still be split into several physical delivery groups. This branch must not be
deployed as the final fix until a Shopify-checkout-wide layer can collapse
those groups to one fee.

## Production

- Host: Railway service `ship-ship` in project `brilliant-elegance`
- URL: `https://ship-ship-production.up.railway.app`
- Deployment: Railway service; verify the active deployment because the
  2026-08-13 production release was uploaded through the CLI, not GitHub
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
- `COLLIE_ALERT_TOKEN`
- `COLLIE_ALERT_URL` (optional; defaults to Collie production)

`BATCHY_API_KEY` must match Hydrogen's production value because it also signs
and verifies the private shipping quote.

## Testing

```bash
npm test
```

The suite includes the reported two-location $76 checkout, independent mixed
pools, tamper/staleness guards, object-form properties, and 441 ready/preorder
threshold × location combinations. The live-process permutation matrix is:

```bash
TARGET=http://127.0.0.1:3555 BATCHY_API_KEY=... node tests/permutation-matrix.mjs
```

See `sessions/2026-08-18-restore-original-fulfillment-pools.md` for the incident
decision, coordinated rollout order, and verification evidence.
