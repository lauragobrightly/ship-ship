# 2026-08-03 — Free shipping race on split orders

## The report

Kelsey Wheaton emailed support@: cart said "You've earned free shipping!" on $76, checkout charged $5. She sent two screenshots. No order — she never completed the purchase.

## Root cause

Her two items live at different warehouses (Hobbit Zip Romper 0-3 only at Co-Op Warehouse, Hobbit Two Piece PJ 2T only at Calibrate Network). Shopify therefore splits checkout into two delivery groups and calls `/rates` **once per group**, each seeing only its own $38.

`server.js` handled that by registering each group's subtotal under `ship:order:{postal_code}:{address1}` and then sleeping a fixed **750ms** before summing. That assumes every callback lands within 750ms of the first. When they don't, the first group wakes alone, sees $38 < $50, and charges $5. The second sees both keys, sums $76, returns $0. Total $5 — her exact receipt.

Reproduced against production before touching anything: two groups in flight 2s apart → **$5.00**. Same two groups concurrent → $0.00.

## The fix (`770d7cd`)

Replaced the fixed sleep with a bounded poll:

- a group whose own subtotal already clears $50 returns immediately, no wait
- a group under the threshold polls every 100ms and returns the instant a sibling registers, up to `CROSS_GROUP_WINDOW_MS` (default 3000, env-tunable)
- window expiry with no sibling now logs a loud warning, because that is the case that can still overcharge

Verified in production after deploy, with guaranteed-unique destination addresses:

| Scenario | Result |
|---|---|
| Genuine single group, $38 | $5.00 ✅ correct |
| Single group, $76 | $0.00, ~1s ✅ |
| Split 2s apart (Kelsey's cart) | **$0.00** ✅ fixed |
| Split 4s apart | $5.00 ❌ still broken |

## Known remaining gap

Skew beyond the 3s window still overcharges. The window is a heuristic, not a guarantee — the service fundamentally cannot see the whole cart. The real fix is structural: stop deciding free-vs-paid inside the carrier service and express "$50+ ships free" as a Shopify automatic free-shipping discount, which evaluates on the whole order. Raising `CROSS_GROUP_WINDOW_MS` buys margin at the cost of checkout latency on sub-$50 carts (they already wait the full window today).

Two other hazards found and left alone, both erring toward the customer:
- Duplicate keys from re-quotes to the same address within the 30s TTL inflate the combined total, granting free shipping that wasn't earned. Pre-existing.
- `destKey` includes `address1`; if Shopify omits it on some calls the groups can't pair. Unproven, not the cause here.

## Tests

`tests/rates.test.js` asserted only `toContain("0")` — *at least one* group free — so it passed while a customer was charged. Now requires both free, plus a new skewed-arrival case.

**The suite does not run.** `jest` chokes on the repo's ESM (`SyntaxError: Cannot use import statement outside a module`), and `NODE_OPTIONS=--experimental-vm-modules` hangs. Pre-existing breakage. Verification was done black-box against the running service instead. Worth fixing separately — a test suite that cannot execute is why the weak assertion survived.

## Blast radius (not acted on)

162 US orders since 2026-06-01, subtotal ≥ $50, split across 2+ locations, charged $5 = **$815.00**. 63 June / 92 July / 7 in the first three days of August. **Laura decided against proactive refunds.** Kelsey had no order, so nothing to refund.

## Customer

Replied from support@ as Fern in-thread (Gmail `19fc9a460f93e1c8`): explained the split-shipment cause, told her it's fixed, invited her to rebuild the cart.

## Note

This repo's directory is linked to the WRONG Railway project (`gregarious-beauty`, which has no ship-ship service), so `railway run` here injects the wrong env — that's why Batchy creds looked missing locally. Deploy happens via GitHub auto-deploy on push to `main`, which is how this shipped. Worth re-linking.
