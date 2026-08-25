# 2026-08-25 — Codex public-app audit, international checkout root cause, Calibrate labels

## What we did

**Ship Ship public app (Codex build) audit.** Ran a 10-agent ultracode workflow plus a requirements-trace agent over `~/AI/Codex/ship-ship-public-app/ship-ship-public` and `~/AI/Codex/scratch/ship-ship-carrier-contract-2026-08-19`, read-only. Laura's actual asks to Codex were reconstructed from `~/.codex/history.jsonl` (saved as `2026-08-25-laura-requirements-to-codex.md`).

Findings:
- Product code is small and correct (Function 418 lines, app ~680, carrier delta +307; all suites pass). Around it: ~6,500 lines of docs/evidence, a 1,054-line acceptance script, 19 of 36 commits docs-only.
- Public-app framing is forced by Shopify: Functions in custom apps need Plus, Wildwoven is on Grow. Unlisted needs the same review.
- Of ~9 Codex gates, Shopify requires four: released version, 3-6 screenshots, screencast + credentials, Public distribution. Shop Pay preorder order, Shop app orders, 8-row manual JSON, "protected-data check" are self-imposed.
- Three blockers not on Codex's list: (1) released Partner version `ship-ship-guarded-2026-08-20` predates the Aug 22 Function rewrite `e8c47c6`; all pool-visible tests ran on the dev preview; (2) Batchy `custom.shipping_pool` writer is untracked/undeployed on `feat/batchy-native-bis`, tangled with unrelated Batchy changes; all 1,653 variants null; (3) carrier branch `railway.toml` healthcheck `/ready` returns 503 in production.
- Regressions vs Laura's asks: Slack alert on free-shipping grants disappears in Function mode; Shop app never physically tested; Canada never investigated; `combinesWith.shippingDiscounts=false` collides with any future free-shipping code.
- Production: untouched by Codex. But Railway meta shows the live carrier (ff07f38e, commit c9e442e) was deployed by a Claude Code session on Aug 19 12:23 and Aug 18 deploys by Codex. Laura ran none of them.
- Key decision still open: measure the unsigned-checkout leak (PDP Shop Pay / Shop app orders under $50 shipping free) before continuing the public-app path.

**Custom domain.** `shipship.waterwitch.io` created on Railway service `ship-ship-public-review` (staging), Porkbun CNAME → `5upvtgnn.up.railway.app` plus `_railway-verify.shipship` TXT. Branch `claude/custom-domain-shipship-waterwitch` (commit aec3108) updates `shopify.app.toml`, listing copy, readiness script, README. Codex `main` untouched. Laura still to: set `SHOPIFY_APP_URL` on Railway, `shopify app deploy` from the branch, enter Riley's Tello number (+1 253 287 5958) as Partner emergency contact.

**International checkout ("not available for delivery to Sweden/Canada/UK").** Root cause: Managed Markets hides products with an empty description. 344 active products, 34 empty descriptions, 34 blocked, identical sets. Zones, rates, catalog 28655583384, customs data, Ship Ship all fine. Fix: `~/Claude/wildwoven-ops/international/2026-08-25-managed-markets-description-backfill/` (REVIEW.md, descriptions.json, backfill.py). Applied to 32 products (Fireflies x2 skipped, no copy). 29 flipped available within ~50 min; Busytown Adult Sleepy Pants also had no HS code / 0 weight (fixed: 610832, CN, 399 g); Shire Crib Sheet and Stained Glass 2pc still in review at 11:15.

**Calibrate labels.** Seven Managed Markets orders since July shipped from Calibrate on their own USPS labels (#36123, #36302, #36336, #36506, #36731, #36839, #36156); customers double-charged duties. Ciara Mackey #36156 refunded CAD 29.44 (refund 931756310680, shipping-only, notify false). Fern reply directed in Collie thread (#cs-inbox ts 1787615209.547969). Collie post to #cs-inbox (ts 1787676694.215649) asks Amanda to take credit + label rule to Ryan Kay.

**Rules written.** Product-entry checklist in CLAUDE.md, Kestrel `workflows/shopify-product-entry.md`, `~/.codex/AGENTS.md`, Claude memory, Paolo preference.

## Next steps
- Confirm remaining 3 products flip; then Fern replies to Michaela (UK), Jacina Peterson (CA), Jacina Pelley (CA), Ida (SE).
- Fireflies description line from Laura.
- Measure the unsigned-checkout leak before more public-app work.
- Kestrel `projects/ship-ship.md` is from April and still says PreProduct; needs a rewrite.
- Update Amanda's Kestrel article (predates Collie).

## Afternoon: Batchy phantom-preorder incident (resolved)

Collie tickets for #37070 and #37084 ("change my preorder size") were not size changes. Co-Op fulfilling Aug 21-23 ready-stock Wild Kratts Anniversary orders on Aug 24-25 fired `orders/updated`; Batchy's `processLineItem` re-read each line against the variant's current status (PREORDER_OPEN since B7 opened Aug 24 14:29) and captured shipped ready-stock lines as B7 demand, emailing "pre-order confirmed, ships by Nov 30". 58 emails sent, 48 wrong; 64 B7 rows, 53 phantom.

Done (Laura: "yes fix all of it deploy etc"):
- Fix in `shep-platform/packages/batchy/src/routes/webhooks.js` (`isCapturableAsNewPreorder`), 4 tests, 21/21 pass. Deployed via `railway up --service batchy`, deployment `b23a10fb`, /health ok. Production Batchy is a working-tree upload of `feat/batchy-native-bis`; the capture logic is uncommitted there.
- 53 phantom rows cancelled in Batchy DB; B7 = 11 real (5 x 5/6, 5 x 7/8, 1 x 9/10).
- 48 correction emails sent as Fern via Resend; log + recipient list in `wildwoven-ops/fulfillment/2026-08-25-batchy-phantom-preorders/`.
- Collie directed on Taylor #37070 and Mary #37084 (shipped today, tracking, exchange on arrival).
- Codex reached the same diagnosis independently from #37066 and wrote `shep-platform/sessions/2026-08-25-batchy-historical-order-reclassification.md`.

Open: stray "placeholder" message in #cs-inbox (12:27) to delete; Managed Markets review of 3 products; Fireflies descriptions; #36942 is the last old ready-stock order and now safe under the fix.

- 13:56: Batchy redeployed as Railway deployment `3c48d821` from commit `4d119ec` (shipping_pool writer restored; token has write_products). Working tree clean, branch not pushed.

- 14:03: Ship Ship public app: `SHOPIFY_APP_URL` set to https://shipship.waterwitch.io on Railway staging service; `shopify app deploy --allow-updates` from branch `claude/custom-domain-shipship-waterwitch` released Partner version **ship-ship-public-5** (new URLs + pool-visible Function e8c47c6), closing the stale-version blocker. shep-platform `feat/batchy-native-bis` pushed to origin.
