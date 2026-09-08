# September 8, 2026 — Shipping alerts and completion plan

## Verified outcome

Laura reported roughly three orders receiving free shipping today and requested
an investigation of the current failure and a better solution informed by history.
As of approximately 11:32 a.m. PT, completed orders do not substantiate that loss.

Read Shopify through Hydra, account `shopify:wildwoven`, verified as Wildwoven,
`kindthing.myshopify.com`, Grow. `SHOPIFY_GET_ORDERS` was an invalid provider tool
name, not an authentication failure. `SHOPIFY_GET_ORDERS_WITH_FILTERS` and
`SHOPIFY_GRAPH_QL_QUERY` succeeded with nested provider success checked.

Ten orders since midnight PT:

| Order | Merchandise subtotal | Shipping | Assessment |
| --- | ---: | ---: | --- |
| #37891 | $38.00 | $6.99 | Ready stock, correct |
| #37892 | $112.00 | $0 | Ready stock, qualifies |
| #37893 | $0 | No shipping line | Draft order; manual 100% discount explicitly says “Replacement — lost package” |
| #37894 | $34.20 | $6.99 | Preorder with WELCOME10, correct |
| #37895 | $140.00 | $0 | Ready stock, qualifies |
| #37896 | $118.00 | $0 | Ready stock, qualifies across two warehouse shipping lines |
| #37897 | $38.00 | $6.99 | Preorder, correct |
| #37898 | $74.00 | $0 | Ready stock, qualifies |
| #37899 | $179.00 | $0 | Ready stock, qualifies across two warehouse shipping lines |
| #37900 | $62.00 | $0 | Ready stock, qualifies across two warehouse shipping lines |

The latest 250 orders span September 2 at 19:20 PT through September 8 at 11:14
PT. None with a positive subtotal below $50 have $0 shipping. There are 43 US
orders with positive subtotals under $50 in this sample. A comparison using
recorded line pool markers, actual discount allocations, and shipping paid
found no mismatches among classifiable, non-test, non-cancelled US non-draft
orders. This is not a complete post-August-27 audit, nor independent proof of
every variant's historical classification. Sanitized evidence is in
`2026-09-08-order-audit.json`; no addresses, customer names, credentials, or
signatures are retained there.

## What the warnings mean

Hydra Slack is quarantined because its provider token was revoked. Hydra route
refused the read. Used the permitted direct Slack reader fallback to read
Wildwoven #alerts (`C09T0U128LX`), after verifying the channel.

| Time PT | Alert | Evidence |
| --- | --- | --- |
| 07:36 | Unsigned ready stock, $38 | A callback received a $0 quote; no completed-order loss established |
| 09:11 | Unsigned ready stock, $36 | Adjacent production callbacks show a $144 cart divided into $108 and $36; the logs lack a checkout identifier, so this is contextual evidence rather than definitive order matching |
| 10:11 | Stale preorder, $38; unsigned ready stock, $21 | Two warnings from the $59 mixed-cart episode. Preorder quote ID matches completed #37897, which ultimately contains only the $38 preorder and paid $6.99 |

Slack permalink for the matched preorder warning:
https://wildwoven.slack.com/archives/C09T0U128LX/p1788887493138509

Production logs show $59 mixed-cart fallback at 10:10:09, followed by signed
$21 and $38 callbacks at 10:10:30. Alerts still arrived at 10:11:33. The
debouncer resolves by destination string plus pool, not a durable checkout ID.
The available logs do not retain destination keys, so they cannot establish why
these corrected callbacks did not cancel those timers. Do not claim that address
changes, a timer bug, or Shopify caching caused this without further evidence.

Carrier callbacks are rate requests. They do not prove checkout completion.
The immediate-invalid alert even says “Customer was charged $0,” which is an
unsupported claim. Held warnings hedge in their body but use a misleading title.
The weekly watchdog only detects overcharges and uses incomplete discount
handling (`total_discount` rather than all `discount_allocations`). It cannot
establish whether free quotes turned into lost shipping revenue.

## Live revision and history

Railway project `brilliant-elegance`, service `ship-ship`, environment production:
deployment `084b1e2b-8c06-4f68-96b8-534787260ddd`, SUCCESS, created August 27 at
19:22:59 PT, commit `5fbd66dad9499a2a5e72d8b0059f7c4cda689cd2`.
Today's production logs demonstrate both signed and whole-cart-certainty paths.

- Original rule: ready stock and preorder qualify separately at $50, regardless
  of physical warehouse count. Current fee is $6.99 per under-threshold pool.
- March–August 3: waiting for sibling callbacks caused timing-dependent errors.
- August 4–6: signed whole-cart context removed the wait, but split quantities
  exposed signature assumptions.
- August 13: a per-warehouse rewrite changed the policy and tests followed it.
  Green tests therefore approved behavior that violated the original promise.
- August 18: restored economic pools with deliberate customer-favoring fallbacks.
- August 19–26: discount, quantity, classification, and alert repairs.
- August 27: whole-cart certainty closed unsigned single-group leakage. Unsigned
  split carts, mixed carts, and ambiguous stale data still have a $0 fallback.

The compiled Kestrel ship-ship article mixes historical per-group/$5 behavior
with current signed-pool behavior. Prefer the live revision and this dated
evidence. The public-app README also has stale release and $5 statements; the
August 25 carrier session records later Partner release `ship-ship-public-5`.
That release is historical evidence, not a fresh Partner-dashboard verification.

## Recommended completion plan

Keep the existing two-pool business rule and finish the existing checkout-wide
implementation. Avoid another carrier-only rewrite or a rollback to the timing
combiner. Neither can recover missing sibling-pool context reliably.

1. Make operational reporting truthful. The local alert text correction now says
   “returned a $0 shipping quote” and leaves order completion unverified. Retain
   warnings as checkout-risk diagnostics. Extend the existing watchdog with an
   order-based result: paid amount, expected amount, order number, variance, and
   classification confidence. Missing classification must be “unknown,” not RTS.
   Account for line discount allocations, shipping discounts, replacements,
   cancelled/test orders, and non-US orders. Deduplicate by order and audit
   revision. Persist quote outcomes using a privacy-preserving correlation key;
   do not equate destination similarity with order identity. Use the existing
   operational runtime rather than adding another service or scheduler.
2. Reuse `/Users/laurawittig/AI/Codex/ship-ship-public-app/ship-ship-public`.
   Its Function sees cart lines and delivery groups together, computes each
   post-discount pool, and removes excess base shipping charges. The carrier
   supplies stable pool rate codes and bounded base fees; Hydrogen ceases to be
   the source of shipping-price authority. Preserve separate “ships now” and
   preorder presentation. A Discount Function can reduce fees, not add a missing
   fee, so base-rate activation and Function activation need a coordinated,
   tested rollback plan.
3. Prove Batchy's variant-level `custom.shipping_pool` publication and automatic
   reconciliation before enabling the Function. Individual sizes can differ;
   manual product tags are unsuitable. Audit coverage and freshness, retry failed
   writes, and report drift. The August 25 record says the writer was deployed,
   but this session did not verify all current variants or that runtime. Missing
   trusted metadata still causes free shipping in the Function, so skipping this
   work would reproduce the same weakness in a new place.
4. Bring the existing candidate to the current $6.99 fee across carrier,
   Function configuration, UI, fixtures, and deployment evidence. The local
   Function default remains $5. Verify the actual Partner release/submission
   status rather than following stale README gates. Live Wildwoven active
   automatic discounts are two BxGy discounts; no automatic app Function is
   active (Hydra GraphQL query exhausted the automatic-discount connection).
5. Finish a small business-contract acceptance set: under/at $50; same-pool
   warehouse splits; $30 RTS + $30 preorder = $13.98; qualifying RTS with
   nonqualifying preorder; discount threshold crossings; split line quantity;
   normal checkout, product-page Shop Pay, and actual Shop app; missing metadata;
   Canada no-op; Function disable/recovery. Prior August 23 evidence already
   proves much of the hosted logic. Refresh only what the final candidate changes
   or where evidence is missing. Acceptance must check both the customer-visible
   shipment breakdown and the completed order's charge.

Shopify Grow requires a public App Store-distributed app to use Functions;
custom-app Functions require Plus. Existing public-app work addresses a real
platform constraint. Do not upgrade to Plus solely on this sample's loss data.
Do not restart a general-purpose public-app product build either: complete the
existing implementation and required distribution work.

Native flat rates avoid duplicate charges within one location group, but native
price thresholds use the entire cart price. They do not preserve independent
RTS/preorder qualification. A third-party app is an alternative only after it
passes the same mixed-size, mixed-pool, warehouse-split, and channel acceptance
set; no vendor is verified as a drop-in replacement in this audit.

Current primary references, checked September 8:
- https://shopify.dev/docs/apps/build/functions
- https://shopify.dev/docs/api/functions/latest/discount
- https://help.shopify.com/en/manual/fulfillment/setup/shipping-profiles/combined-shipping-rates

## Changes and limits

Changed only local fallback-alert copy and existing text assertions. Eight alert
tests passed. No pricing logic, production service, Shopify settings, or customer
orders changed. No messages sent. Preserved the pre-existing untracked August 26
session note. The proposed watchdog and Function completion work is not built or
deployed by this session. There is no demonstrated emergency revenue loss today
to justify an unreviewed production pricing cutover.
