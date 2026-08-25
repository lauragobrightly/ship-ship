# 2026-08-13 — Groups-first: the signing system is gone

## Why

Three incidents in ten days (Aug 3 race, Aug 6 punitive freshness, Aug 13
discount mismatch) all traced to one root: the free-shipping policy needed
whole-cart knowledge inside Shopify's per-group carrier callbacks, so Hydrogen
stamped signed pool totals into the cart and every cart-mutation path became a
correctness dependency. Laura's call: "we should first look at groups and then
decide" — per-shipment policy, delete the machinery. She chose:
- **$5 per group, fully independent** — every delivery group ≥$50 ships free,
  else $5. No combining. A split cart pays per package.
- **Per-bucket progress bars** in the cart drawer.

## Carrier (this repo) — commit 9430431, deployed ~9:40am

`/rates` now: kill switch → international guard (unchanged) → gift-card-only →
mystery-box promo → classify items (RTS/PO via `_shipping_bucket` marker with
Batchy fallback, unchanged) → per-bucket group subtotal vs threshold → rates.
Deleted (−956 lines): verifySignedShippingQuote and all helpers, STALE_QUOTE,
priceForSignedPool, order_totals whole-cart qualification, the cross-group
cache/poll combiner, tests/signed-quotes.test.js. `_ww_ship_*` attributes are
now inert relics.

Tests: rates.test.js rewritten to per-group expectations (14/14).
Permutation matrix rewritten to the new policy — tamper rows now expect the
group's REAL item pricing (forging attributes does nothing since nothing reads
them). Local 33/33; **production 33/33 after deploy**.

Local-test gotchas discovered: `railway variables` only works from the linked
dir (not worktrees); Laura's shell profile exports SHOPIFY_ACCESS_TOKEN
(wildwovenstore) and `node --env-file` does NOT override pre-existing env vars
— source the .env with `set -a` instead. A zombie server on :3555 also served
one misleading matrix run; kill by port before local runs.

## Storefront — feat/groups-first-banner (f4379b90), NOT yet deployed

Agent-built from live commit 1a43a131 in worktree
`headless-migration/groups-first-banner`: deleted shipping-quote.server.js /
sync-shipping-quote.server.ts / their test (−800 lines), removed stamping from
cart + checkout routes, ShippingMeter now bucket-labeled ("Ready to ship" /
"Pre-order"), all cart-wide copy reworded to per-package (FAQ shipping answer,
PDP badge, ValueProps tile, DescriptionAccordion). 83 tests pass. Laura
deploys. NOTE: announcement bar text lives in Shopify content — check it
separately if it promises cart-wide free shipping.

## Customer-facing implications

- Split/mixed carts now pay $5 PER under-$50 package (Holly's $68 mixed cart:
  $10, was $5). Site copy now says "per package" everywhere in code.
- Amanda's pending Holly reply explains her PAST $5 correctly; don't promise
  that framing forward.

## Open

- Laura: deploy feat/groups-first-banner (Hydrogen, from the worktree).
- Nightly production matrix cron + weekly overcharge sweep (proposed, unbuilt).
- git push main → origin to restore GitHub parity (check auto-deploy wiring
  first).
- Shopify announcement bar copy check.

## Watchdogs SHIPPED (10:00-10:45am) — commit includes watchdog.js

- Nightly 2:30am PT: matrix self-test against the live process (execFile of
  tests/permutation-matrix.mjs, TARGET=localhost). Silent on 33/33; alerts
  severity=high through Collie /alerts/paolo (Bearer COLLIE_ALERT_TOKEN) on
  any mismatch. First run: Fri Aug 14 ~2:33am.
- Weekly Mon 7:00am PT: overcharge sweep of last 7d US orders. Classifier
  (unit-tested, 22/22 suite): any shipping line > fee, or a single-line order
  ≥$50 charged the fee. International + mystery-box exempt. ALWAYS posts one
  line (clean or findings) — dead-watchdog visibility. First run: Mon Aug 17.
- Validation: manual sweep re-found exactly the 3 pre-fix overcharges from the
  refund list (#36605 #36489 #36377), zero false positives after scoping to
  US. Two test alerts posted to Slack during proof — ignorable.
- Env added on ship-ship service: COLLIE_ALERT_TOKEN, SWEEP_SHOPIFY_TOKEN
  (ops admin token; the app token lacks read_orders).
- Boot verified in Railway logs ("[watchdog] armed"); post-deploy matrix
  33/33. Hydrogen banner deployed by Laura ~9:50am; live checkout probes:
  $38→$5.00, $76→FREE, mixed→"2 shipments" $5+$5.
- macOS note: no GNU `timeout` on this Mac — bounded railway logs reads with
  `| head -N` instead.

## Still open
- git push main → origin (parity; confirm auto-deploy wiring first).
- Shopify announcement bar copy check (content-managed, not code).

## Closed out (10:51am)
- All refunds handled (other CC session): original 6/$40 list + the sweep-
  flagged trio are the same era, pre-fix.
- Sweep-flagged orders verified pre-deploy vintage (Aug 7/8/12, all before
  the 9:40am groups-first deploy). Live build cannot produce the shape
  (post-deploy $76 single-group probe → FREE; matrix 33/33 ×3).
- Add-to-cart popups (Amanda 5am: UK Stained Glass, US Boho Moons swaddle):
  NOT reproducible after Laura's 9:50am storefront deploy — live headless
  probes on all three PDPs (incl. the ™-handle UK locale path) add cleanly.
  Root cause of the 5am reports never captured; if it recurs, get the exact
  popup text/screenshot (Collie reads attachments now).
