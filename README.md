# Ship Ship Hooray

Wildwoven's Shopify carrier service for ready-to-ship and preorder rates.

## Latest verification — September 8, 2026

The authorized implementation and deployment record is in
[the September 8 implementation note](sessions/2026-09-08-monitoring-and-function-preparation.md).
The new daily 7 a.m. Pacific audit checks completed orders from the previous
Pacific calendar day for both undercharges and overcharges, and compares all
active variant pool fields against Batchy. Shopify reads use `HYDRA_URL` and
`HYDRA_API_KEY`. Missing metadata is reported as unknown. The optional checkout
Function mode remains disabled pending app approval and final hosted acceptance.
All 1,772 active variant pool fields were backfilled through Hydra and verified.

Initial investigation (before the implementation):

Production remains commit `5fbd66d`, Railway deployment `084b1e2b`.
Today's ten completed orders show no accidental free shipping: three ordinary
under-$50 orders paid $6.99, six ready-stock pools qualified, and one manually
discounted lost-package replacement had no shipping line. Four Slack warnings
describe three checkout episodes, not four completed orders. The latest 250
orders had no positive under-$50 subtotal with $0 shipping; the stamped-pool
comparison also found no mismatches, subject to classification limitations.

A local, undeployed wording correction calls fallback events "$0 shipping
quotes" and explicitly leaves checkout completion unverified. Its eight alert
tests pass. The current weekly watchdog detects overcharges only; it does not
measure lost shipping revenue. The public-app Function is not active on
Wildwoven. See [the audit and completion plan](sessions/2026-09-08-shipping-alerts-and-completion-plan.md)
for evidence, history, limitations, and the recommended next work.

## Shipping rules

- Hydrogen signs the post-discount ready-stock and preorder pool totals before
  checkout. Every line carries its pool total, and one line per pool is the fee
  anchor.
- Ship Ship Hooray verifies those signatures with the shared Batchy credential.
  Pools at or above $50 are free. Below $50, only the group containing the
  signed anchor costs $6.99, even when Shopify splits the pool across locations.
- Ready-stock and preorder pools always qualify independently. The virtual
  Pre-Order Warehouse remains the fulfillment boundary.
- Honest stale or missing quote data fails customer-safe at $0 because a single
  callback cannot know whether another warehouse holds the rest of its pool.
  Invalid HMACs and other malformed/tamper-shaped data fail customer-safe at
  $0 and alert. This bridge prioritizes never charging a customer for a
  warehouse split; the future Shopify Function restores exact enforcement.
- If Shopify divides the fee-anchor line itself between warehouses, no partial
  callback charges it. Hydrogen prefers a quantity-1 anchor to avoid that case.
- Customer-safe $0 fallbacks send warnings through Collie to the configured
  Slack channel. A single-pool cart stays silent when a checkout-applied
  discount changes the signed total but both the old and new totals remain at
  or above $50; free shipping is certain in that case. Missing/invalid data,
  mixed-cart ambiguity, and threshold crossings still alert. Identical
  quote/reason alerts are deduplicated for 15 minutes.
- International orders defer to Shopify's native rates.

Shopify can call `/rates` once per fulfillment group. A callback cannot see its
sibling groups, so it cannot reconstruct either stock pool reliably. The signed
quote supplies that missing cart-wide context without waiting for sibling
callbacks. Hydrogen's `/checkout` bridge refreshes every quote synchronously.
Carts that bypass the bridge — the PDP Shop Pay button, the Shop app, draft
orders — arrive unsigned. Every callback also carries Shopify's own
`order_totals.subtotal_price` for the whole cart, so when a callback's items sum
to exactly that figure it *is* the whole cart: there is no sibling warehouse
group, nothing can double a fee, and the bucket is priced with certainty from
numbers the customer cannot edit (`wholeCartCertainty` in `server.js`). Stale
and rejected stamps on a whole cart price the same way. Only a callback that is
a slice of a bigger cart still takes the customer-safe $0 fallback and alerts;
that is deliberate undercharging, never per-warehouse overcharging. An
under-$50 unsigned cart split across several physical delivery groups is the
one remaining gap, and it needs a Shopify-checkout-wide layer to collapse
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
- `COLLIE_ALERT_CHANNEL` (optional Slack channel ID; production uses `#alerts`)

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

The matrix sends `X-Ship-Ship-Probe` set to `probeToken()` from `server.js`
(an HMAC of the string `ship-ship-probe` under `BATCHY_API_KEY`). That header
is what keeps probe carts out of the Collie alert channel. Any other value is
refused with a 400, so a hand-written probe can no longer flood alerts by
forgetting or misspelling it (2026-08-26: 22 alerts in four minutes). Before
pointing anything at production, send the token or expect a 400.

See `sessions/2026-08-18-restore-original-fulfillment-pools.md` for the incident
decision, coordinated rollout order, and verification evidence.
