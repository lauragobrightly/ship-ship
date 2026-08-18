# Restore original fulfillment-pool shipping

Date: 2026-08-18
Status: Hydrogen path implemented and verified locally; channel coverage gap
found; not ready to deploy

## Decision

Shipping qualification follows two customer-visible fulfillment pools:

- ready-to-ship
- current preorder batch

Each pool receives one independent $50 threshold and, below it, at most one $5
fee. Shopify inventory locations and delivery groups do not create additional
fees.

This reverses the 2026-08-13 groups-first pricing decision without restoring
the older callback-timing race. Hydrogen supplies signed whole-pool totals and
a single fee anchor; Ship Ship verifies those values independently in every
delivery-group callback.

## Failure behavior

- Valid signed pool: free at $50; otherwise only the complete anchor line pays
  $5.
- Anchor line divided between warehouses: all partial copies return $0 instead
  of charging the same fee more than once.
- Honest stale or unsigned quote: $0 with a warning. A callback cannot infer the
  pool from its warehouse fragment, so customer-safe undercharging is the only
  non-racy fallback.
- Invalid signature or tamper-shaped metadata: $5.
- Unclassifiable cart in Hydrogen: checkout returns 503 and asks the customer
  to retry instead of stamping a knowingly wrong pool.
- Non-US destination: unchanged; Ship Ship returns no rate and defers to
  Shopify/native international services.

Shopify documents carrier `subtotal_price` as pre-discount and
`discount_amount` separately. Verification compares the signed post-discount
cart total with `subtotal_price - discount_amount`, fixing the discount
freshness error without bypassing the pool threshold.

## Shop and accelerated checkout gap

The Shop sales channel and Hydrogen's direct `ShopPayButton` do not pass through
the Storefront API cart `/checkout` bridge, so they do not carry `_ww_ship_*`
line attributes. A 2026-08-18 read-only audit found four Shop orders among the
latest 100 orders; none had shipping quote attributes. All four were RTS orders
over $50 and received free Ship Ship rates, so those examples do not test the
under-$50 case.

Batchy's open guard intentionally confines active preorder products to the
Hydrogen publication. Shop and the direct PDP Shop Pay button are therefore
RTS-only. That avoids mixed-pool ambiguity, but it does not solve an under-$50
RTS cart divided across physical locations: separate carrier callbacks still
cannot select one and only one $5 fee without shared cart identity.

The former unsigned path appeared to cover these channels by using Shopify's
whole order subtotal for RTS and, on older releases, a same-address timing
cache. It could qualify the threshold in common one-group checkouts, but it
could duplicate the $5 fee across multiple under-threshold warehouse groups.
Do not deploy this candidate as complete channel coverage. The durable fix must
run in Shopify checkout across channels (for example, a Shopify Function that
can see the whole cart and all delivery groups), while retaining the signed
Hydrogen path as defense in depth.

## Watchdog

The weekly classifier no longer treats multiple $5 warehouse lines as
legitimate. It flags:

- more than $5 charged across all RTS lines or all preorder lines;
- a charged pool whose line-item subtotal is at least $50; and
- any non-promotion shipping line above $5.

The order sweep requests line items so it can reconstruct the two pools.

The rate handler also sends an immediate Collie-to-Slack warning whenever it
grants free shipping because metadata is unsigned/stale or an under-$50 anchor
was divided across warehouses. Alerts contain no customer address or email and
are deduplicated by pool, reason, and quote for 15 minutes. Matrix probes carry
an internal header so nightly tests do not create incident noise.

## Verification

- Jest: 59 tests passing.
- Candidate live-process matrix: 35/35 scenarios passing.
- Coordinated Hydrogen quote tests, typecheck, and production build pass.

## Rollout

Blocked pending the channel-independent Shop/Shop Pay design above. Once that
path is implemented and tested:

1. Deploy the Hydrogen producer first. Its private attributes are inert while
   the current carrier ignores them.
2. Verify a cart line contains `_ww_ship_v=2`, shared pool cents, and one anchor
   per pool after passing through `/checkout`.
3. Deploy Ship Ship from the coordinated carrier commit.
4. Test $38 RTS, $76 RTS split across locations, $30 RTS + $30 preorder, and a
   discounted under-$50 pool in checkout.
5. Watch carrier warnings and actual order shipping lines for 120 minutes.

Rollback order is carrier first, then Hydrogen. Record the active Railway
deployment ID and Oxygen deployment before switching production.
