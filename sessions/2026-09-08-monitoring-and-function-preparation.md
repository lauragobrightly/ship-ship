# September 8 — Shipping implementation

Laura authorized proceeding with the September 8 recommendation: “ok let's go then”.

## Catalog repair completed

Through Hydra `shopify:wildwoven`, set only absent `custom.shipping_pool`
variant metafields with `compareDigest:null` to avoid overwriting concurrent
writes. Batchy's live variant table supplied preorder states; variants not
tracked by Batchy retain its established ready-stock default. Checked all 69
active preorder candidates against Shopify inventory: none had positive
ready-stock-location availability. All pages of the active catalog were read
again after the writes: 1,772 variants, 1,703 ready-stock, 69 preorder, zero
missing fields, zero mismatches. Complete local assignment evidence is in
`2026-09-08-shipping-pool-backfill.json` (not part of the source release).

Provider details: Composio's `SHOPIFY_GRAPH_QL_WRITE_OPERATIONS` takes a named
operation, not arbitrary query text. For this mutation use
`SHOPIFY_GRAPH_QL_ADMIN_EXECUTE` with `document` and `variables`. Two parameter
validation failures preceded the successful writes; they made no changes.
Each of 71 successful batches checked nested success, GraphQL errors,
metafieldsSet userErrors, returned owners, and returned values.

## Carrier and monitoring implementation

Based on current production `5fbd66d`, preserving its v3 signatures and August 27
whole-cart-certainty fix. Quote alerts now say a $0 rate was returned and never
claim a completed order or charge. Existing weekly overcharge-only audit is
replaced by one daily 7 a.m. Pacific audit of the previous Pacific calendar day.
The calendar boundary calculation covers 23/25-hour DST days without gaps.

The audit reads Shopify through Hydra and compares purchase-time line pool
attributes, line discount allocations, and shipping paid. It reports
undercharges and overcharges separately, not netted across pools. It excludes
test/cancelled orders, non-US orders, gift-card-only orders, mystery promotions,
and draft orders. Missing/conflicting attributes, edited quantities,
unrecognized shipping codes, and non-policy shipping promotions require review;
they are never silently assumed to be lost revenue or ready stock. It recognizes
the existing policy Function's shipping discount separately from promotions.
Order IDs deduplicate overlapping API pages. Truncated connections, parser
warnings, bad pagination, wrong account, and nested provider failure fail the
audit rather than producing a clean result.

The same daily report compares every active variant field against Batchy's live
state, reporting missing or stale fields. This is detection, not automatic
catalog repair. Batchy's existing inventory-transition writer remains the
owner of live field updates; no Batchy code was deployed by this session.

The live query rehearsal found a Shopify parser pitfall: unquoted ISO timestamps
silently broaden a search (colon components become invalid fields). The new
reader quotes both timestamps, omits invalid `status:any`, rejects Shopify
search warnings, and independently checks every order timestamp. The first
68-order rehearsal had that invalid window and must not be used as a daily
financial result. It sent no Slack message. Regression tests cover the failure.

The checkout-Function carrier path is opt-in under
`SHOPIFY_NATIVE_SHIPPING_FUNCTION_ACTIVE=true`. When off, current production
pricing remains intact. When on, Batchy classification rather than shopper
attributes selects one stable RTS_STD/PO_STD/MIXED_STD base rate at $6.99/$13.98;
the Shopify Function handles qualification and fee deduplication. Do not enable
until the automatic discount is active and final hosted tests pass.

## Hydra connection

Added a non-approver caller `ship-ship`, scoped to actor `ship-ship` and account
`shopify:wildwoven`. Keys are stored only in Railway environment variables;
neither code nor these notes contains credentials. Existing caller registrations
and legacy admin access were preserved. No provider accounts changed.

Hydra redeployment `b5f0251f-082f-4440-a8ed-9662ff28c84e` failed after the image
build with no runtime log or build error reported by the CLI. The old deployment
continued serving. Retry `57ee0c7e-380d-4c87-9401-5ac79501f733` succeeded, with
health still reporting source revision `0d5f2d0` and the new deployment ID.
The new Ship Ship caller successfully routed and executed live Shopify reads.
Restart Codex before future Hydra maintenance, per the global environment-change
instruction; the running service was verified over HTTP in this session.

## Public app preparation

In `/Users/laurawittig/AI/Codex/ship-ship-public-app/ship-ship-public`, branch
`codex/shipping-completion-2026-09-08`:
- merged canonical domain change `aec3108` (local cherry-pick `0c373a6`);
- app, Function, and new-shop database defaults now use $6.99;
- migration does not overwrite existing merchants' explicitly saved fees;
- current-fee tests cover threshold edges, mixed pools, warehouse splits,
  and a merged $13.98 base;
- old $5 fixtures remain explicitly configured compatibility tests;
- dev-store acceptance runner now expects $6.99 and current carrier titles;
- 16 app tests, 55 Function tests, typecheck, lint, web build, and Function
  WebAssembly build passed.

CLI verifies active Partner version `ship-ship-public-5`, released August 25.
The in-app browser execution tool is unavailable; no current Partner review
screen or physical Shop-app checkout was claimed as verified. The new app
candidate has not been released to Shopify or installed on Wildwoven.

## Remaining activation work

Refresh hosted acceptance with the final carrier and $6.99 Function configuration,
including a real Shop-app checkout, then verify/complete Shopify distribution
and review. Do not turn the base-rate carrier mode on while awaiting approval.
On the real Wildwoven cutover, current production already uses pool-specific
codes, so the old shared-code migration instructions are not the current plan:
activate the compatible Function first, verify it, then enable carrier base
rates. Allow cached old quotes to expire and verify fresh carts. Roll back the
carrier to bridge mode before deactivating the Function.
