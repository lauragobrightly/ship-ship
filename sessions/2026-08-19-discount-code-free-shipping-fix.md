# 2026-08-19 — Discount codes were waiving the under-$50 shipping fee

## The incident

Orders **#36872** and **#36879** (2026-08-19, 09:03 and 09:28 PT) each bought a
single $30 Smaug Lovey with **WILDINSIDERS** (10% off) and shipped **free**.
Control: **#36870** at 08:27, same product, same price, **no discount code**,
correctly charged **$5**.

## Root cause

Commit `b70e7f2` "Make shipping fallbacks customer-safe" (deployed 2026-08-18
13:11 PT) changed a stale signed quote from charging $5 to charging $0:

```diff
- const rtsPrice = invalidRtsQuote ? appConfig.feeUnderThreshold : signedPrice ?? 0;
+ const rtsPrice = invalidRtsQuote ? 0 : signedPrice ?? 0;
```

Separately, the freshness check compared Hydrogen's signed cart total against
Shopify's **post-discount** subtotal only. Hydrogen stamps
`_ww_ship_cart_cents` from `cart.cost.subtotalAmount` at cart mutation and again
at `/checkout` — both of which happen **before** the customer can type a code
into hosted Shopify checkout. So the signed total is pre-discount and Shopify's
is post-discount, and they can never match once a code is used.

Production log:

```
Signed ready-stock quote stale — signed cart total 9600 does not match
Shopify post-discount subtotal 8640 — cart changed after stamping
— failing customer-safe at $0
```

**The $50 threshold was never reached.** `priceForSignedPool` returns on
`if (quote.stale) return 0;` before any threshold comparison. So the cart's
value was irrelevant — *any* cart with a checkout-entered discount code shipped
free. The $30 was a coincidence.

## Why 35/35 stayed green

All three of the matrix's discount scenarios (`s01`–`s03`) sign the
**post-discount** total, i.e. a discount Hydrogen already saw in the cart. The
real path — a code typed into hosted checkout after stamping — had no coverage
at all.

## The fix — branch `fix/stale-quote-discount-mismatch`

1. **Freshness accepts either total.** The signed value is legitimately
   pre-discount (code typed at checkout) or post-discount (code already in
   cart). Match either. A cart that genuinely changed matches neither, so the
   staleness guarantee is unchanged.
2. **Threshold prices on money actually paid.** For a single-pool cart the whole
   cart discount belongs to that pool, so `effectivePoolCents` is the
   post-discount value and drives the $50 test. Mixed carts cannot be allocated
   by a carrier callback, so they keep the signed value and stay alert-worthy.

## Policy confirmed by Laura, 2026-08-19

> "If somebody's cart drops below fifty because they're using a discount, they
> need to add more to their cart to go over fifty. That's inherently true and
> needs to stay true."

**The $50 free-shipping threshold is measured on the post-discount amount the
customer actually pays.** A discount that drops a cart under $50 reinstates the
$5 fee. This is intended behavior, not a regression.

## Testing

Added 3 matrix scenarios covering the real checkout-entered-discount path.

| Scenario | Deployed `24ee8b0` | With fix |
| --- | --- | --- |
| `s05-code-typed-in-checkout-under` (the incident) | **$0.00 FAIL** | $5.00 PASS |
| `s06-code-typed-in-checkout-over` | $0.00 PASS | $0.00 PASS |
| `s07-code-crosses-threshold-down` | **$0.00 FAIL** | $5.00 PASS |
| **Matrix total** | **36/38** | **38/38** |

Jest 67/67 (from 61; +6 including a direct regression test for #36872), stable
across three consecutive runs. The local probe ran against production env with
`FALLBACK_ALERTS_ENABLED=false`, so no Slack alert was emitted during testing.

## Not fixed here

- Mixed RTS + preorder carts still cannot allocate a cart-wide discount per
  pool. They keep the signed pre-discount pool value and continue to alert.
  That is the case the checkout-native Function is meant to solve, and it
  remains blocked on Shopify distribution (Wildwoven is not on Plus).
