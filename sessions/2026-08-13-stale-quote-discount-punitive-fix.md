# 2026-08-13 — Discount codes tripped the signed-quote freshness check; stale now falls back to unsigned pricing

## The complaint

Customers charged $5 shipping on $50+ preorder carts (reported 2026-08-13).

## What it was NOT

- Not the B6 cutoff-date change (Aug 12) — batch metadata never reaches rate logic.
- Not the two new Short Set variants (7/8, 9/10) — both classify and verify
  correctly (permutation rows u06/u07 prove the Batchy fallback path).
- Not a v1/v2 verifier skew — production ship-ship already runs `97137c2`
  (deployed outside GitHub; origin/main is still `d57c6a0`, one commit behind).

## Root cause

`97137c2` (deployed Aug 6) added a freshness check: reject a signed quote when
`_ww_ship_cart_cents` ≠ Shopify's `order_totals.subtotal_price`, and charge the
punitive $5. But Hydrogen signs `cart.cost.subtotalAmount` — **post-discount**
— while the carrier callback's subtotal is **pre-discount**. Every stamped cart
with a discount code (WILDINSIDERS, PLANTWILD, WELCOME10…) mismatched and was
billed $5/bucket regardless of the $50 threshold. Production log deltas made it
obvious: 9900 vs 11000, 6300 vs 7000, 2700 vs 3000 — all exactly 10%.

Second mode, same family: a line added after the async re-stamp (PDP express
checkout racing `waitUntil`) leaves one group line unstamped → `unsupported
_ww_ship_v ""` → same punitive $5.

Reproduced black-box against production with a legitimately signed $60-pre /
$54-post cart → `PO_STD 500`.

## The fix (implemented, tested, NOT yet deployed)

`server.js`: verification now has three outcomes instead of two:

- **verified** — signed pool prices the group (unchanged);
- **stale** (new `STALE_QUOTE` sentinel) — freshness mismatch or an unstamped
  line in a stamped group → fall back to *unsigned* pricing, exactly as if the
  cart had never been stamped. Unsigned pricing derives from Shopify's own
  callback items/order totals, which a shopper cannot forge, so this cannot be
  used to buy free shipping (matrix row s03 pins that a stale quote never
  grants its *signed* pool).
- **rejected** — tamper-shaped (HMAC, inflated qty, wrong pool, two anchors,
  currency) → punitive $5, unchanged.

Known policy nuance: stale/unsigned preorder groups qualify on **pre-discount**
item totals, while fresh signed quotes qualify post-discount. Restoring exact
post-discount policy for discounted carts needs a v3 contract that signs the
pre-discount total (storefront + verifier change, sequenced verifier-first).
Optional follow-up.

## Testing

- `npm test` — 45/45 (added: discount-code cart free; unstamped-line group
  free; stale-under-threshold still $5; repointed the old fail-closed test).
- `tests/permutation-matrix.mjs` (new, this session) — 33 end-to-end scenarios
  signed with the real secret against a live server: bucket × threshold ×
  v1/v2 × split/tamper/stale × Batchy-fallback × cross-group race × gift
  cards × international. Local fixed build: 33/33. Production passes 30/33
  (fails s01/s02, wrong-reason-passes v2-15) — i.e., prod exhibits exactly the
  diagnosed defect.

## Deploy (Laura runs)

Production deploys are currently NOT GitHub-synced (prod = local `97137c2`,
origin = `d57c6a0`). Two options:

1. `railway up` from this directory (now correctly linked to
   brilliant-elegance/ship-ship — it was mislinked to gregarious-beauty).
2. Or commit + push to main to restore GitHub parity — but confirm whether
   GitHub auto-deploy is still wired before relying on it.

After deploy, re-run: `TARGET=https://ship-ship-production.up.railway.app BATCHY_API_KEY=... node tests/permutation-matrix.mjs` → expect 33/33.

## Make-it-right list

387 orders since Aug 6 scanned: **6 orders overcharged, $40 total** (all
ready-stock bucket; the preorder rejections in the logs appear mostly as
abandoned checkouts, which is worse). List with emails/amounts:
`sessions/2026-08-13-overcharge-list.json`. Refunds via
`~/Claude/the-operator/lib/shopify/safe-refund.js` (shipping-only refunds are
allowed as pure shipping refunds; `notify: false`).

## Files touched

- `server.js` — STALE_QUOTE sentinel, staleSignedQuote(), version/freshness
  checks downgraded to stale, tri-state handling in /rates, priceForSignedPool
  guards stale.
- `tests/signed-quotes.test.js` — +3 tests, 1 repointed.
- `tests/permutation-matrix.mjs` — new 33-scenario E2E harness.
- `sessions/2026-08-13-overcharge-list.json` — refund candidates.

## Refunds executed 2026-08-13 ~09:26 PT (Laura approved)

Shipping-only via safe-refund.js (`notify: false`), $30.00 total. Required
passing `parentTransactionId` — without it the wrapper forwards Shopify's
`suggested_refund` kind and the execute step 422s.

- #36377 → refund 930483339416, $5.00
- #36477 → refund 930483372184, $5.00
- #36489 → refund 930483404952, $5.00
- #36498 → refund 930483437720, $10.00
- #36605 → refund 930483470488, $5.00
- #36459 excluded — already refunded $10.00 previously (likely CS).

No customer emails sent; Laura may opt for a Fern note separately.

## Open items

- Deploy the fix (Laura — `cd ~/Claude/ship-ship && railway up`; a build was
  also triggered at ~09:17 by mistake, check dashboard before re-running).
- Decide on v3 contract (pre-discount cart total) for exact post-discount
  thresholds on discounted carts.
- Reconcile ship-ship git: local main is ahead of origin and prod was deployed
  from a tree, not GitHub. Commit this fix + push to restore one source of truth.
- Hydrogen side unchanged this session; PDP express-checkout stamping race
  still exists but is now harmless ($0 instead of $5 on honest carts).
