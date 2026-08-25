# 2026-08-18 — Shipping policy regression and rollback audit

## Outcome

The current domestic complaints are produced by the August 13 policy change,
not an intermittent rate-calculation failure. Ship Ship now applies the $50
threshold to each Shopify delivery group. If Shopify splits a $76 ready-stock
cart into two $38 groups, production deliberately returns $5 for each group.

This differs from the original Wildwoven rule: ready-stock and the current
preorder batch are two fulfillment pools, and each pool gets one independent
$50 threshold across physical warehouse splits.

Do not restore the April build. Its 750 ms callback combiner caused the known
split-order race. The least-risk temporary correction would reverse only the
August 13 group-level pricing behavior on top of the current carrier and accept
documented customer-favoring edge cases while a durable two-pool contract is
built.

No code, configuration, Shopify settings, or production services were changed
during this audit.

## When the changes began

- March 15, `8f8361c`: non-US callbacks began returning no Ship Ship rates so
  Shopify's international configuration could handle them.
- March 30, `fd0cb0`, `1f64884`, `863e2be`: same-pool callbacks across physical
  locations began using a short timing window to combine subtotals.
- April 10, `1a456e8`: last Ship Ship change before the August incident cycle.
- August 3, `770d7cd`: incident-driven changes began after a $76 all-RTS cart
  split into two $38 callbacks and paid $5. The prior build had potentially
  affected 162 US orders since June 1, totaling $815 in shipping charges.
- August 4, `d57c6a0` plus Hydrogen `0478dcf8`: signed fulfillment-pool totals
  replaced the callback timing guess.
- August 6, `97137c2` plus Hydrogen `08ff86e1`: fixed signatures when Shopify
  reduced a line's quantity in a split callback.
- August 13, `9a917d7`: made stale or discount-mismatched signed quotes fall
  back instead of charging the punitive fee.
- August 13, carrier `9e2957e` and Hydrogen `f4379b90`: deleted the signed
  two-pool contract and changed pricing to one threshold per physical Shopify
  delivery group.
- August 13, `5df304f`: added a watchdog whose expectations match the new
  per-group policy.

The active Railway deployment was uploaded by CLI on August 13 at 10:00:15 PT.
Live logs and behavior prove it contains `9e2957e` and `5df304f`, although the
deployment has no attached Git SHA. Local `main` is `5df304f`; `origin/main` is
still `9a917d7`.

## Why it changed

The signed two-pool implementation had three incidents in ten days: callback
timing, split quantities, and discount/freshness mismatches. Claude recommended
making the carrier a pure function of each physical delivery group. On August
13, Laura explicitly selected "$5 per group, fully independent" after the UI
warned that a cart split across two under-$50 warehouse groups would pay $10.

That selection was explicit, but it changed the original business rule from
RTS/preorder fulfillment pools to Shopify's physical warehouse groups. Amanda's
current reports show that the simplified policy is unacceptable in practice.

## Why green tests did not protect customers

The tests were rewritten to approve the new policy:

- `tests/rates.test.js` expects two $38 RTS groups in a $76 cart to cost $10.
- `tests/permutation-matrix.mjs` expects a $76 RTS line split to a $38 callback
  to cost $5.
- `tests/watchdog.test.js` calls a $76 order with two $5 shipping lines
  legitimate.

The watchdog therefore stays green while customers experience the exact issue
Amanda reported. Its 33/33 result proves internal consistency with the August
13 policy, not correctness against the original customer promise.

## Rollback findings

- April `1a456e8` restores the 750 ms race and does not fix Canada.
- August 4 `d57c6a0` restores the signed-quantity failure.
- August 6 `97137c2` restores the discount/freshness punitive-fee failure.
- August 13 `9a917d7` is the best historical carrier base, but a carrier-only
  rollback would mostly run unsigned because Hydrogen `f4379b90` removed quote
  stamping. RTS could undercharge mixed carts and split preorder groups could
  still overcharge after the timing window.
- A coupled carrier and Hydrogen rollback restores roughly 878 lines of async
  cart stamping and the same dependency surface responsible for the August
  incidents. It is not a safe emergency move.

Recommended temporary path, if authorized: start from deployed/local
`5df304f`, reverse only `9e2957e` pricing semantics, keep current classification
and monitoring, add customer-contract tests, shadow-replay sanitized callbacks,
then switch the registered service in one controlled cutover. This may
undercharge some mixed carts and is a bridge, not the durable design.

## Canada / Stained Glass

Canada is separate from the domestic rate policy.

- Ship Ship has returned no rates for every non-US destination since March 15.
- The carrier service is attached only to the General profile's US Domestic
  zone. Canada's active rates come from DHL eCommerce, DHL Express, and FedEx.
- Live Shopify reads through Hydra confirmed the Stained Glass two-piece product
  is active, globally published, and stocked at Co-Op Warehouse. The inspected
  2T variant had 65 units at Co-Op and zero at Calibrate.
- Co-Op is in the location group with a Canada zone, but Canada has no static
  backup rate. The exact failure needs the customer's address/cart and a native
  carrier or Managed Markets trace.

A Ship Ship code rollback cannot fix the Canadian checkout failure.

## Sources checked

- `compiled/people/amanda.md`
- `compiled/projects/ship-ship.md`
- `compiled/decisions/build-vs-rent.md`
- Ship Ship Git history, tests, current code, Railway status, and live logs
- Hydrogen Git history and the August shipping/add-to-cart session notes
- December 10, 2025 MemPalace record of the original shipping-pool rule
- August 13 Claude transcript containing the policy selection
- Collie August 12 and August 17 international/shipping queue notes
- Hydra-routed Wildwoven Shopify product, inventory, carrier, and delivery
  profile reads
