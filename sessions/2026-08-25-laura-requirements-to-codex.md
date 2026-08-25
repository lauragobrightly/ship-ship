# What Laura told Codex about Ship Ship (from ~/.codex/history.jsonl, Aug 3-25 2026)

## 2026-05-01 11:39
well what do you know, you fixed that Shop Pay button on your first attempt

## 2026-05-01 11:51
that's amazing. Can you verify that the current cart fly out and general cart behavior are connected to Ship Ship Hooray or they're returning the right price buckets? you can check Paolo (if youre authed there) or look at our Claude files on this. basically you get free shipping over $50 on in stock OR pre order items, you can't mix and match between buckets

## 2026-05-04 11:25
What about Veritas, barcode bible, smart pre-order tracking, batchy, smart inventory reordering etc

## 2026-05-06 11:48
ok that's running now -- what about this When you buy shipping labels through Veeqo you are protected against A-to-Z Guarantee Claims, if you are using the recommended carriers. lol

## 2026-05-06 15:05
ok great. Let's launch that on Friday, in honor of Mother's Day. And then ON Mother's Day we'll launch a Mom + Mini pre-order

## 2026-05-07 15:29
what does the "multi location" setting mean
Laura • Just now
“Multi-location” means you’re telling our shipping software to pull in your Shopify locations (warehouses, retail stores, popups) so orders can be assigned to a location and stock can be tracked across those locations.
Once enabled, Shopify orders can be fulfilled from the location that has stock, and if one location can’t fulfill everything, the order can be split across multiple locations where stock is available.
In Veeqo, you then map each Shopify location to a Veeqo location, and you can set a location priority list to control where stock is allocated from.

## 2026-05-07 15:30
That notification means Veeqo couldn’t pull that Shopify order into our shipping software because something in the order data didn’t match what Veeqo expects. 
Most common causes to check:
The channel connection needs a refresh: Settings → Channels → (your channel) → Settings → Authorize Connection, then wait 30 minutes.
One or more line items don’t exist in Veeqo (or aren’t Linked and Active): Warehouse → Listings → search each SKU and confirm status is Linked and Active.
A Shopify plugin added a line item that doesn’t exist in Veeqo.
Can you send a screenshot of the full error details (and the order’s line items) so

## 2026-05-07 15:31
and does this work for our pre-orders/orders where we have multiple SKUs etc... or is it a deal breaker

## 2026-05-08 08:48
ok, great... let's pivot now to Batchy/pre-order troubleshooting and fixing. The Map of Rohan will launch in about an hour. We need to manually push inventory from the packing list into SKUs in Shopify for Cammi at Co-Op warehouse, and then make sure that all product descriptions and photos are in

## 2026-05-08 09:06
and then the middleware can route pre-orders effectively too. so it splits things out like LOCATION AND STATUS (if pre-order then hold)

## 2026-05-08 09:06
so then she doesn't even see pre-orders in Veeqo if we don't need it

## 2026-05-08 09:07
yeah so I think the main thing is/was... we always needed this in order for our pre-order system to work right. We always needed a little Batchy app. What we didn't REALLY need was Goldi

## 2026-05-08 14:27
that's because youre in my personal gmail ... we need to generate shipping labels for her too

## 2026-05-08 15:10
help me understand why our Shopify emails aren't showing appropriate attribution... Why are my Shopify Emails (marketing campaigns sent via Messaging) not showing Sales data? They show opens/clicks but not that

1 step completed
Here's what's likely happening with your missing sales data in Shopify Messaging email campaigns:

Sales attribution requires a tracked click-through to your store. Shopify attributes sales to a marketing activity based on the last-clicked interaction — meaning a customer must click a link in your email, land on your store, and then complete a purchase within the attribution window (30 days). If customers are:

Opening the email but not clicking through, or
Clicking but purchasing on a different device without cross-device tracking connecting the sessions
...then no sale gets attributed to that campaign, even though opens and clicks are recorded separately.

Key things to check/consider:

Are your email links tracked? Shopify Messaging should auto-append UTM/tracking parameters to links, but verify your email template links are actual clickable URLs pointing to your store (not plain text or broken links).
Attribution window: Sales are only attributed if the purchase happens within 30 days of the last click. If customers are converting much later, they won't show.
Cross-device gap: A customer might open/click on mobile but purchase on desktop. Cross-device data is supported as of March 2023, but it relies on the customer being identified (e.g., logged into Shop or having provided their email at checkout).
No sessions = no sales: If the campaign drove zero sessions (clicks that resulted in store visits), sales will always show as $0 regardless of opens.
Quick diagnostic: Go to Analytics → Reports → Performance by marketing activity and filter to your email campaigns — if Sessions is also 0 or very low, the click-tracking on your email links is the root issue to investigate.

Measuring marketing performance
 
Marketing

We're using a Hydrogen storefront too
That's an important detail! Hydrogen storefronts are headless, which means Shopify's standard storefront tracking (used for marketing attribution) doesn't work automatically out of the box.

With a Hydrogen/headless setup, you need to manually instrument analytics for sales attribution to work. Specifically:

Shopify's Web Pixel / Customer Events — you need to implement the analytics APIs in Hydrogen to fire the right events (page views, add-to-cart, purchases). Without these, Shopify can't connect a session from an email click to a completed order.
UTM parameters must be captured and persisted — when a customer clicks your email link (with UTM params), your Hydrogen app needs to read and store those params across the session, then pass them along at checkout. If your Hydrogen app isn't doing this, the attribution chain breaks.
Checkout attribution — Hydrogen uses Shopify's hosted checkout, but the referrer/UTM data needs to be passed into the checkout session for Shopify to credit the sale to the email campaign.
What to check:

Are you using Hydrogen's built-in Analytics component (from @shopify/hydrogen)? It handles a lot of this if configured correctly.
Is sendShopifyAnalytics being called on page views and purchases?
Are UTM params being forwarded to checkout via cart attributes or checkout attributes?
If the analytics instrumentation isn't fully set up in your Hydrogen storefront, opens and clicks will track (those are email-side metrics) but sales will never attribute — which matches exactly what you're seeing. I'd recommend reviewing the Hydrogen analytics documentation to verify your implementation covers all the required events.

## 2026-05-08 15:35
I'm on chat with them right now -- "
Great detail here, Laura. Let me look into how Shopify Email attributes sales in its campaign dashboard.

Your analysis is spot-on, Laura. Here's what's likely happening:

The core issue: attribution scope in the campaign dashboard

Shopify Email's campaign activity report attributes sales based on last-clicked interaction within the past 30 days, and it tracks sessions originating from the online store. Measuring marketing performance

Your suspicion about Shop Pay / Shop app checkout is well-founded. Orders completed through the Shop app or Shop Pay accelerated checkout may not be surfaced in the Shopify Email campaign report even when customerJourneySummary correctly records the email attribution at the order level. The campaign dashboard and the GraphQL attribution data use different scopes and pipelines.

Key gaps that explain the discrepancy:

The campaign report may only count conversions through the Online Store sales channel, not Shop app or Shop Pay express flows
The 4-order gap (23 custom-attributed vs. 19 via customerJourneySummary) could reflect orders where the last click was overridden by a more recent touch (e.g., a direct Shop app open)
The $556 revenue gap between your custom attribution ($1,710) and Shopify's ($1,154) aligns with this channel-scoping difference
What you can do now:

Cross-reference those 19 GraphQL-attributed orders against the Performance by UTM campaign report in Analytics (not the Email campaign dashboard) — it uses a broader attribution scope
Check if the 4 orders missing from customerJourneySummary completed via Shop app directly
This is a known reporting gap between campaign-level dashboards and order-level attribution data. The order-level data in GraphQL is the more accurate source. This would need to be reviewed by Shopify's Email/Analytics team to confirm whether the dashboard is intentionally scoped to Online Store only.

Would you like me to pull up the UTM campaign report for May 8 to compare against your numbers?"

## 2026-05-08 15:43
I want to inform you as well that the Shopify Email campaign dashboard tracks conversions through a specific funnel it counts orders from sessions where a subscriber clicked your email and then visited your online store. The "Unique visitors" metric specifically refers to subscribers who visited the online store after viewing the email. This is a narrower scope than what customerJourneySummary captures at the order level.

However,It would be a limitation for me to confirm from documentation alone exactly which checkout flows the dashboard excludes for example, whether Shop Pay accelerated checkout, Shop app orders, or /cart/c/ landing pages are intentionally out of scope. That level of detail about the dashboard's exact attribution pipeline isn't publicly documented.

I might need 3-5 minutes to investigate this one. I will keep you posted!

## 2026-05-12 09:31
I'd like to open up a pre-order / new "batch" -- ASAP. This requires us to get Batchy/that system really working. It broke a lot of things the last time we tried to use it on Hydrogen. Can you get agents on understanding the entire history, what I want to do with batch based ordering, etc.

## 2026-05-12 09:47
what about baking in a "demand based pre-order" which makes certain items have to be purchased in bulk? like a kickstarter kind of thing? we should build that in

## 2026-05-13 14:52
I'm delivering her - Consciously Baby Design System.zip and CB Emails.zip for her team to upload into Claude.ai/design ... Canva link for templates (2), confirm website IG feed is working, links fixed, pop-up live, automated email flows (abandoned checkout, abandoned cart, welcome flow) are live plus one campaign mail sent. Also attaching the audit.

## 2026-05-14 11:24
this is what I gave it, IDGAF read_all_orders,read_analytics,read_customer_events,read_channels,write_channels,read_customers,read_price_rules,write_price_rules,read_discounts,write_discounts,write_draft_orders,read_draft_orders,read_files,write_files,read_gift_card_transactions,write_gift_card_transactions,read_gift_cards,write_gift_cards,write_inventory,read_inventory,read_locations,read_marketing_integrated_campaigns,write_marketing_integrated_campaigns,read_marketing_events,read_markets,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_metaobject_definitions,read_metaobjects,read_online_store_navigation,write_order_edits,read_order_edits,read_orders,write_orders,read_product_feeds,read_product_listings,write_product_listings,read_products,write_products,write_reports,read_reports,read_shipping,read_content,write_content,read_store_credit_account_transactions,write_store_credit_account_transactions,read_store_credit_accounts,read_third_party_fulfillment_orders,write_third_party_fulfillment_orders,read_pixels,customer_read_customers,customer_read_draft_orders,customer_read_markets,customer_read_metaobjects,customer_read_orders,customer_write_orders,customer_read_store_credit_account_transactions,customer_read_store_credit_accounts,unauthenticated_write_bulk_operations,unauthenticated_read_bulk_operations,unauthenticated_read_bundles,unauthenticated_read_checkouts,unauthenticated_read_customers,unauthenticated_read_customer_tags,unauthenticated_read_metaobjects,unauthenticated_read_product_inventory,unauthenticated_read_product_listings,unauthenticated_read_product_tags,unauthenticated_read_selling_plans,unauthenticated_read_content

## 2026-05-14 13:17
ok she's working now... ## Today's Sales Report (May 14, 2026)

**Total Orders: 2**  
**Total Revenue: $295.00**

### Order Details:

**Order #33364** - $120.00 (10:23 AM)
- Customer: Heidi Peterson (San Francisco, CA)
- Items:
  - Middle-earth™ Elevenses™ Zip Romper (6-12) - $38.00
  - Gardenthyme Crib Sheet - $46.00
  - Gardenthyme Zip Romper (6-12) - $36.00
- Status: Paid, ready to fulfill

**Order #33363** - $175.00 (9:57 AM)
- Customer: Meghan Azralon (Pleasanton, CA)
- Items:
  - The Fellowship of the Ring™ Discovery Set - $175.00
- Status: Paid, ready to fulfill
- Source: Facebook ad campaign

### Quick Stats:
- Average order value: $147.50
- Both orders from California customers
- All items are in-stock and ready to ship
- One order came from Facebook advertising
- Zero shipping charges (free shipping applied)

Both orders are fully paid and awaiting fulfillment. Strong start to the day with a mix of multi-item and discovery set purchases! -- so Shopify is showing 6 orders

## 2026-05-15 09:46
can you pivot for a second and help me generate a label? You need to find Katy's address, calculate the weight etc, generate her a label to return it to CAMMI in Florida -- Fern  [5:30 AM]
T1 | Katy | #32570 — Customer initiated exchange for Gilded Fellowship pants (size issue) on April 20th but shipping label never generated; website portal errors preventing completion after 3+ weeks and multiple follow-ups.
4 repliesFern  [5:30 AM]
From: Katy Joyce <kmatt1491@gmail.com>
Order: #32570 — Order total: $? — Adult Dreamwalker Joggers in The Lord of the Rings™: Gilded Fellowship (M), Folk...
VIP customer (0 orders, lifetime value: $1142.91 — not refund amount)

Hi,
 I need to exchange the Gilded Fellowship pants from order #32570. I
 processed the exchange through the online portal on April 20th. However,
 the shipping label never loaded on the website. I tried accessing it again
 and it didn't work. I can't even cancel the exchange to try to re-process
 i



---

My draft response:

Hi Katy,

Three weeks is way too long — I'm sorry this has dragged on like this. The Loop portal has a known issue with label generation that's been affecting some exchanges, and I can see your Return ID 106667140 is sitting stuck in the system.

I'm handing this directly to our team to manually generate your return label and get this exchange moving for you. You'll receive the label at kmatt1491@gmail.com shortly — no portal needed on your end.

You're right that the Gilded Fellowship print runs large, so sizing down should give you the fit you're looking for. We'll also include a small gift as a thank-you for your patience while this got sorted out.

Warmly,
Fern, Wildwoven Customer Support

- Loop Return ID 106667140 is stuck — manually generate return shipping label for ADULT-DRMWLK-LOTR-FELLOWSHIP-M (order #32570) and email directly to kmatt1491@gmail.com
- Confirm exchange size (size down from M — likely S) before processing; loop back to Katy if size confirmation needed
- VIP customer ($1,143 LTV) — include a small gift card or store credit for the 3-week delay; suggest $10–$15 to Laura/Amanda for approval
- Escalate to #customer-service (Laura or Amanda) to approve and action the above



---
Auto-sending in 60 seconds. React :x: to cancel.
Fern  [7:07 AM]
Cancelled by @Amanda
Amanda  [7:07 AM]
@LW need help with this one. Need Loop to give her a label. 
LW  [9:45 AM]
let me just get her a label now, hold on

## 2026-05-15 10:27
so it looks like her approval button flow is not wired up yet LW  [10:26 AM]
@Collie For Katy Joyce order #32570, please prepare a Shopify replacement
 order for the Gilded Fellowship Adult Dreamwalker Joggers in size S. Do
 not email the customer. Use the original shipping address if you can
 verify it, set send_receipt false, send_fulfillment_receipt false, and
 decrement inventory obeying policy. Post it for approval before creating.2 repliesCollie  [10:26 AM]
On it — I’m checking context and will come back in this thread.
[10:27 AM]I’ve staged the next step above. I’ll wait for approval or a follow-up in this thread.

## 2026-05-18 10:17
ok great, how do we want to handle this? Fern  [8:41 AM]
T2 | Kaylie | INVESTIGATE — #32922 — Customer's package marked undeliverable due to damage by carrier; requesting replacement
5 repliesFern  [8:41 AM]
From: Kaylie Knowland <kaygrebeck@gmail.com>
Order: #32922 — Order total: $? — Map of Middle-earth™ Frodo Lovey (null), The Lord of the Rings™ Icons Zip Romper...
New customer (0 orders, lifetime value: $68 — not refund amount)

Good morning,

 My order was marked undeliverable because it was damaged. Can I please get a replacement?

 Order number: 32922
 Tracking number: D10017334123211



 



---

INVESTIGATION NEEDED

INVESTIGATION:

**What needs to be checked before responding:**

1. **Carrier damage claim** — Tracking D10017334123211 shows the package was marked undeliverable due to damage. Need to confirm:
   - Which carrier handled this shipment (order is tagged "Calibrate" — likely a Calibrate Network carrier)
   - What the carrier's damage/undeliverable scan actually says
   - Whether the package is being returned to sender or was discarded/destroyed

2. **Return to sender status** — Is the damaged package being routed back to Wildwoven/Calibrate? If so, ETA?

3. **Replacement inventory** — Order includes:
   - LOVEY-LOTR-ME-MAP (Map of Middle-earth™ Frodo Lovey) — **Known issue item**. Per the Gandalf/Frodo mismatch policy, a "replacement" of this SKU will just be another Frodo. Resolution options are: swap to LOVEY-LOTR-MORIA (Doors of Durin Gandalf Lovey) OR full refund. But since this customer hasn't complained about the wrong character — she ordered after the listing was renamed — the relevant question is just whether we can reship. Need Laura/ops to advise on resend vs. refund for a carrier-damaged package.
   - ZIP-LOTR1-18-24 (LotR Icons Zip Romper 18-24) — Need to confirm inventory availability for reshipping.

4. **Resolution path** — This is a carrier damage situation, not a return/defect. The package never arrived. Options are:
   - Reship both items (requires inventory confirmation)
   - Full refund of $68.00 (requires Laura/Amanda approval since it exceeds $50)
   - Combination (reship what's in stock, refund what isn't)

5. **Customer identity** — Profile shows no order history under this email, but the order data confirms kaygrebeck@gmail.com placed #32922. Low-confidence memory mentions a "Kayla" with comms issues on a different order — not clearly related. No red flags here; carrier damage is verifiable via tracking.

**Do not draft a customer response until:**
- Carrier damage scan is confirmed
- Inventory for both items is checked
- Laura approves refund if going the refund route (total $68.00 > $50 threshold)
- Ops decides reship vs. refund vs. split resolution

---
No draft generated — investigate first, then reply here with findings and I'll draft a response.
Amanda  [6:31 AM]
@LW in this situation, I'll order a new package but do I need to file a claim? Let me know how to go about doing that. I'll get a new order placed for her later. This is what tracking says:

ABOUT THIS TRACKING EVENT
Your package has been damaged. Please contact the seller directly for further information
Viktor  [9:09 AM]
Not touching the customer reply, but I’m seeing two shipping-exception questions this morning (damaged-in-transit + delivered-but-not-received). Once Laura confirms the preferred handling, I can turn it into a tiny CS decision tree for Amanda/The Operator so this is faster next time.LW  [9:26 AM]
give me a second, going to train Collie now

## 2026-05-20 10:15
okay, so yesterday we were able to fix the Vico integration with Cami. Now I don't know if we ended up shipping our middleware, and now Cami is saying that she would rather me send her a PDF of the labels because she doesn't understand how to use Vico (voice to text, Vico = Veeqo)

## 2026-05-20 10:32
we need those run and to pick up any orders that have come through for her since. the almost $500 in shipping is fine.

## 2026-05-20 13:42
this does not make sense and Claude is bungling this audit -- Channel: "USPS PO XXXXX" / "USPS" on Amex
  90-day spend: $18,926
  What it is: Shopify Shipping labels (USPS Click-N-Ship rail, billed direct to
    your Amex)
  Who's buying: Whoever clicks "Create label" in Shopify admin — most likely
    Cammi + Calibrate
  ────────────────────────────────────────
  Channel: UPS direct
  90-day spend: $1,056
  What it is: Misc UPS labels
  Who's buying: Probably ad-hoc
  ────────────────────────────────────────
  Channel: EasyPost recharges
  90-day spend: $950
  What it is: EasyPost wallet top-ups (rollout started Mar 27)
  Who's buying: Cammi shop
  ────────────────────────────────────────
  Channel: Stamps.com
  90-day spend: $339
  What it is: $10.99/mo subscription only — no bulk postage going through it
  Who's buying: Subscription, mostly idle
  ────────────────────────────────────────
  Channel: FedEx
  90-day spend: $7 
  What it is: Negligible
  Who's buying: —
  ────────────────────────────────────────
  Channel: Total
  90-day spend: $21,278
  What it is:
  Who's buying:

  So your real shipping P&L is $21k, not the $1.3k EasyPost number.
  
  The big takeaway: ~95% of labels in 90 days are bought through Shopify admin →
   USPS on your Amex. EasyPost is only doing 4.5% of label volume. If the plan
  was to migrate label-buying onto EasyPost for better rates/reporting, the
  migration is barely started.
  
  Who's actually clicking the buttons — best guesses (need to confirm in
  Shopify):
  - Cammi (FL warehouse) fulfilling DTC orders
  - Calibrate if they have Shopify admin access (many 3PLs do, and the volume
  matches — their 2,155 orders + Shopify Shipping at ~$8/label ≈ $17k) 
  
  Most likely scenario: Calibrate is fulfilling 2,000+ orders via Shopify admin
  → USPS labels charged to your Amex, AND charging you their separate $29.5k 3PL
   fee. Their real all-in $/order is ~$22, not $13.68.
  
  Two questions to settle this:
  1. Does Calibrate have Shopify admin access / does their workflow create
  Shopify labels?
  2. Should I dig into Shopify order fulfillment metadata (location_id) to
  attribute USPS spend to Cammi vs Calibrate vs Selery?
  
✻ Brewed for 20s · 1 local agent still running

  11 tasks (7 done, 4 open)
  ◻ Agent 6: Carol &amp; manufacturer payments
  ◻ Synthesize master 90-day P&amp;L › blocked by #6
  ◻ Fix CLAUDE.md re: Cammi label procurement › blocked by #9
  ◻ Store key audit findings to Paolo › blocked by #9
  ✔ Agent 1: Shopify draft products
   … +6 completed

## 2026-05-20 13:44
• I found an existing 2026-05-20-90day-pl audit directory with raw Shopify order
  data, so we do have something concrete to work from. The key correction is:
  card descriptors prove payment rail, not operator. Shopify/Veeqo fulfillment
  metadata has to attribute who created/fulfilled each label.

• Waited for background terminal

• Explored
  └ List ls -R
    Read shipping_by_warehouse.csv, AUDIT-REPORT.md
    Search _orders.jsonl in .
    Read shipping_reconciliation.csv, 05-shipping-reconciliation.md, 03-
    easypost.md,
         _analyze.py

────────────────────────────────────────────────────────────────────────────────

• You’re right. That audit is mixing three different things and then drawing a
  too-confident conclusion.

  The clean version:

  $1.3k EasyPost = only labels bought through the EasyPost account. That
  includes the Cammi May 8 batch and other FL labels. It is not total shipping.

  $21.3k shipping ledger = actual cash/card shipping spend across Amex/Shopify
  Balance: USPS direct, UPS, EasyPost, Stamps.com, FedEx. This is the real
  shipping cash-out bucket.

  But the bad leap is here: “USPS PO / USPS on Amex = Shopify Shipping labels
  bought by Cammi + Calibrate.” That is plausible, not proven. The card
  descriptor tells us payment rail/merchant, not who clicked the button or which
  warehouse shipped it.

  The existing report also contradicts itself:

  - It says Calibrate’s $29.5k invoices are “all-in, postage folded in.”
  - Then the newer note says Calibrate may also be generating $17k of USPS
    labels on your Amex.
  - Both cannot be treated as fact without checking Shopify fulfillment metadata
    and Calibrate invoice detail.

  The right audit is:

  1. Take every Shopify fulfillment in the 90-day window.
  2. Pull location_id, location name, tracking company, tracking number,
     fulfillment created date, and ideally fulfillment/event author if Shopify
     exposes it.
  3. Match tracking numbers against EasyPost shipment records.
  4. Anything not in EasyPost but USPS tracking likely maps to the Amex USPS
     bucket.
  5. Attribute by fulfillment location: Calibrate, Co-Op/Cammi, Selery, manual/
     Laura.
  6. Then compare Calibrate’s invoices to Calibrate-attributed Shopify labels to
     see whether you are double-paying postage.

  So the current safe conclusion is:

  Shipping cash-out is about $21.3k, not $1.3k. EasyPost is a minority label
  rail. But “Calibrate caused most of the USPS Amex spend” is not settled yet.
  That needs fulfillment-level attribution before we call it.

## 2026-06-02 09:16
and what is the shipping label situation? Can we fork the EasyPost billing so each shop bills for its own labels?

## 2026-06-14 09:23
yes Grand Hyatt just arrived, check email I think it's in my inbox. What about these options Cheap flights from Kiwi.com
Tue 23 Jun
Set up price alerts

Receive alerts when the prices for this route change.

Bags
Cabin baggage
0
Checked baggage
0
Stops

Any

Direct

Up to 1 stop

Up to 2 stops

Allow overnight stopovers
Connections

Self-transfer to different station/airport
Carriers
Booking options
Travel hacks
Exclude countries
Times
Duration
Price
Days

Tue 16 Jun
-

Wed 17 Jun
-

Thu 18 Jun
-

Fri 19 Jun
-

Sat 20 Jun
-

Sun 21 Jun
$394

Mon 22 Jun
$263

Tue 23 Jun
$219

Wed 24 Jun
$198

Thu 25 Jun
$181

Fri 26 Jun
-

Sat 27 Jun
-

Sun 28 Jun
-

Mon 29 Jun
-

Tue 30 Jun
-


Best
$219 · 1h 40m

Cheapest
$219 · 1h 40m

Fastest
$396 · 1h 35m

Other options
Earliest departure

15:15
1h 40m
Juneyao Airlines
16:55
TAO
Direct

HGH




$219
for 2 passengers

09:30
1h 35m
Shandong Airlines
11:05
TAO
Direct

HGH




$396
for 2 passengers


Kiwi.com Guarantee
The ultimate travel package designed to ensure a hassle-free trip.

17:30
1h 40m
Shandong Airlines
19:10
TAO
Direct

HGH




$395
for 2 passengers

AI Mode
BETA
Plan your trip by chatting with our AI trip planner


07:15
1h 45m
Shandong Airlines
09:00
TAO
Direct

HGH




$395
for 2 passengers

18:35
1h 45m
Shandong Airlines
20:20
TAO
Direct

HGH




$395
for 2 passengers

07:55
1h 45m
Shandong Airlines
09:40
TAO
Direct

HGH




$395
for 2 passengers

12:10
1h 45m
Shandong Airlines
13:55
TAO
Direct

HGH




$395
for 2 passengers

07:30
1h 50m
China Eastern Airlines
09:20
TAO
Direct

HGH




$417
for 2 passengers

16:00
2h
China Eastern Airlines
18:00
TAO
Direct

HGH




$417
for 2 passengers


Save money
Depart between Sun 21 Jun – Thu 25 Jun and save $38.

22:10
1h 55m
Hainan Airlines
00:05
+1
TAO
Direct

HGH





$449
for 2 passengers

Price trends

The ultimate travel package
The Kiwi.com Guarantee provides instant solutions to disruptions, continuous support, and automated travel services.

Feedback
Qingdao TAO‎ – Hangzhou‎ trips

## 2026-06-14 09:44
so Kiwi has been helpful because they consolidate everything and their agents handle stuff. I'll make sure we have luggage selected. Can you check our confirmed airlines and see if any charge fees for changing as we'll have to change Eric's passport number? Cheap flights from Kiwi.com
Home
Changing or correcting traveler details
Article
Can I correct traveler details?
If you book a trip with incorrect traveler details or fill in incorrect info — such as your passport or ID number — later on, you can request a change:
Sign in and open your trip.
Scroll down to the Passengers section and click on “Edit passenger”. 
Edit the details and attach a passport/ID copy with the correct details.

Changes are possible only after we fully confirm your booking with the carriers up to 48 hours before the trip.
Our agents will check the possibilities with the carriers and get back to you with the details. The conditions of the change and any possible fees will depend on the carriers — some carriers allow small corrections for free, while others always charge a fee.
If there’s a fee, we’ll ask you to pay it before we proceed with the change. Once we change the details, we’ll send you a new e-ticket.
What if I don’t correct the details?
If there's a mistake in your name, nationality, date of birth, or passport/ID details, the carrier might not allow you to board. You might also face difficulties getting through immigration.
Did this article help you?
Related articles
Can I change the passenger?
It might be possible to transfer your ticket to another traveler for a fee.
Service levels and fees
Upgrade your service level for faster support and smaller processing fees.
☎ How to contact us
Visit our Help Center to see our contact details.
Still need help?
Help | Kiwi.com

## 2026-06-30 15:31
Can you take a look at our last iteration of Batchy, launch agents to understand why it was working/not working so we can get it running today? What if I want to open a pre-order batch for July 1-30

## 2026-06-30 16:03
so let's test this, can we clone the current Women's Boho Moons Dress and try to run a pre-order on it? What happens?

## 2026-07-16 15:40
ok Claude is pissing me off, it's really bungled this whole holiday PO thing with Carol and we need to nail it tonight, can you pull all recent PO work, pull the WhatsApp I downloaded with Carol (in Downloads), look up the Formula, look up the preorder etc, I think it's all been done recently, check the recent .md files etc Claude did

## 2026-07-21 11:26
thank you, yes FOB invoice prices aren't taking into account shipping

## 2026-07-23 10:02
and I'm paying double shipping

## 2026-07-23 10:32
I don't think we can involve my forwarder, we likely need to use her shipping people

## 2026-07-23 13:46
ok did we do the double shipping calculation? How much money have we spent and how much would we save by sending all Calibrate to Cammi

## 2026-07-24 07:47
1.⁠ ⁠The price remains the previous quote: $10967, the 50% deposit/50% balance terms.
2.⁠ ⁠The DDP price includes all fees; there will be no additional costs after delivery to the door.
3.⁠ ⁠Delivery within 10 days after receiving the deposit.
   Matson Express: Ships every Wednesday. Lead time is approximately 25-30 days after sailing to receive the goods. If fast, goods will be received by the end of August.
   General Vessel: Entering the warehouse around August 5th, sailing on the 14th. It takes about 50-55 days after sailing to receive the goods, arriving around early to mid-October.
4.⁠ ⁠Unloading is required by yourself in the end. It is best to have a forklift (a truck with a tail lift is available, but since the cargo size is relatively high, it may not be able to unload). You will be notified in advance during delivery.
5.⁠ ⁠Transportation insurance will cover the total value of all products of $10967.
6.⁠ ⁠13 pallets, 34CBM, gross weight 5840kg.
7.⁠ ⁠The goods will not arrive between August 20th and 25th. [7/24/26, 7:43:00 AM] Laura: What is the pricing for delivery Matson Express
[7/24/26, 7:43:06 AM] Laura: Oh I see it now haha
[7/24/26, 7:43:26 AM] ~Bella Zhang: The Merson boat is too expensive.
[7/24/26, 7:43:51 AM] ~Bella Zhang: suggest you take the usual boat.
[7/24/26, 7:45:44 AM] ~Bella Zhang: Then, if we place an Alibaba Trade Assurance order and enter your address, the Alibaba platform will charge a platform tax of $1359.89.
[7/24/26, 7:46:51 AM] ~Bella Zhang: We usually fill in the Chinese address for our customers. I don't know how you used to deal with this problem. /Users/laurawittig/Downloads/Quotation\ List\ \(Matson\ Express\).pdf /Users/laurawittig/Downloads/Quotation\ List\ \(General\ shipping\).pdf

## 2026-07-25 10:22
We'd also want to make sure that **they pay for their own shipping** using live rates right? I think that's standrd, can you research? Prevent them from pre-ordering, we should enforce a minimum, and for now, if they're **ordering from multiple warehouses** we should not eat that cost right

## 2026-07-28 17:00
Hassan is bothering me about the power of attorney, I thought Erica Customs Broker handled it but apparently not. Can you please check the inbox to see what the latest was, and I guess we should just send a POA over to his shipping agency anyway? Remember, we were talking to another customs broker (not Erica) so that is not the person to look for. Find the shipping agency email/contact info and fill out a POA for me please. Use hydra to get into the email

## 2026-07-31 13:27
ok so there's no way in heck we're going to get Cammi to count all fo that stuff, it makes no sense. The only thing we can do is compare packing list quantities x sales to understand what was sold, and assume she has the rest. likely will need some forensics on that, launch a few agents. What order started shipping to her, etc... Goldi Veritas etc should have that info. And then yes send that note back to lauren, but before doing that, can you review her last email to see if there's stuff we need to do

## 2026-08-03 10:00
who cares about bundles? they are zero cost because they are bundles? I have no idea. Sheet Sets, we DID NOT ORDER those, we nevger ordered them. THey would be have sold via preorder and then refunded

## 2026-08-03 10:01
we also should figure out what is going on with preorder items, are they being double counted etc

## 2026-08-03 10:06
for instances where pre-orders are not actually funded (like someone only ordered 1 full sheet, no one else did, so we didn't place the production order) we will usually issue a giftcard. that's a very small amount of orders, maybe 20 over the whole year

## 2026-08-03 17:55
why are customers being charged $5 for shipping when they're ordering in stock items above $50? Ship Ship Hooray isn't working properly, it should be only doing this when an item is a pre-order item. Is it that items were listed as preorder and now are in ts [Image #1]

## 2026-08-04 09:15
/goal examine our entire pre-order 'batchy' / how it works with goldi / order placement pipeline from end to end. We originally based it on PreProduct but I was having issues with their software. I did a full "wishlist" end to end experience dump with Claude at some point. I want to launch a Jimothy pre-order but I need it to go flawlessly. The shipping splitout (Preorders over $50 ship free but if other things are in cart then they're subject to $50 threshold ready in stock) -- the order confirmation, final order count, ability to see current pre-order status, no order left behind, customer able to see pre-orders in their account, etc. etc.

## 2026-08-04 11:54
wasn't the issue though that we need to split out pre-order products from non pre-order, and so then we used the pre-order warehouse

## 2026-08-04 14:37
ok, and then I had a note earlier where I was nervous about launching a pre-order because of our old system, was that worked on by another session today can you check please

## 2026-08-04 14:50
/goal keep fixing things and making our pre-order experience the best so we can launch tonight

## 2026-08-04 20:49
Last login: Tue Aug  4 14:31:50 on ttys002
laurawittig@Lauras-MacBook-Pro ~ % cc






















  ! cd ~/AI/Claude/headless-migration/giftcard-hotfix && npx shopify hydrogen
  deploy --env production
  
  Branch now has two commits on top of what's live:
  
  ┌──────────┬─────────────────────────┐
  │          │                         │
  ├──────────┼─────────────────────────┤
  │ a474e553 │ Sold-out size indicator │
  ├──────────┼─────────────────────────┤
  │ 2e66208d │ Gift card footer link   │
  └──────────┴─────────────────────────┘
  
  One thing to flag for later: I built this against the ProductForm.tsx that's
  actually in production, which is Codex's version. Your dirty checkout has a
  different, diverged copy of that same file. When you reconcile the two
  branches, this fix will need to be carried across rather than assumed present.
     
✻ Worked for 4m 41s
  
────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents

## 2026-08-05 10:46
is the website broken? Someone is "unable to add items to shopping cart" and I think it's the Ship Ship Hooray bullshit, please check ASAP

## 2026-08-06 10:15
ok, can you help me QA this email before I schedule it for Shopify? It will show you how I want stuff to look anyway. The links we should be using are /local-legends-pre-order for the collection btw SUBJECT LINE OPTIONS
1. Jimothy has entered the chat
2. The raccoon that broke the internet lives here
3. Meet Local Legends — 10 days only

PREHEADER
Jimothy and Sasquatch, patched and stitched. Pre-order closes August 15.

===========================================================

LOCAL LEGENDS
Jimothy & Sasquatch

The little raccoon that's taken the world by storm also happens to live in
our backyard, along with another local legend, Sasquatch. We wanted to pay
them (and our hometown!) tribute in the best way we know how – through
whimsical pajamas and daywear, with options for the whole family.

-----------------------------------------------------------

STITCHED, NOT PRINTED

Two pieces in this drop are different from anything we've made before.

The raglan sweatshirt carries Jimothy on the chest as a felt patch, raised
and textured – the kind of detail you notice with your fingers before your
eyes. Raglan sleeves, 80% cotton and 20% ramie, with our own woven
Wildwoven label at the neck.

The corduroy dad hat wears his patch on the front and his name across the
back – JIMOTHY, embroidered in white. Six-panel slate blue cord,
unstructured fit, curved brim, and a fabric strap with an adjustable brass
closure and a D-ring to tuck the excess away. One size fits all, and it
arrives flat so you can shape the brim exactly how you like it.

These two aren't pajamas. They're the pieces you'll actually wear to
drop-off, to the coffee shop, to the trailhead – the ones people will stop
you about.

-----------------------------------------------------------

THE REST OF THE COLLECTION

We built out the full range so you can mix, match, and coordinate however
feels right for your family:

For kids — Zip romper · 2-piece pajama set · Jogger set · Short set
For adults — Women's relaxed short-sleeve PJ set · Men's shorts ·
             Men's relaxed pants · Dreamwalker joggers
For the house — Quilted oversized blanket

Sizes run newborn through adult 3XL, so the whole family can match. (The
blanket will end up on your couch. We don't make the rules.)

-----------------------------------------------------------

10 DAYS ONLY

This pre-order is open now through August 15. We make what's ordered in
that window and nothing beyond it, then everything ships by the end of
November – in plenty of time for the holidays.

Nothing to race for at 9am, no restock list to join. Just get your order in
before the 15th.

[ PRE-ORDER LOCAL LEGENDS → ]

-----------------------------------------------------------

Plus, a portion of every sale will be donated to PAWS – a Washington based
urban animal rescue organization. Our owner Laura has called them a few
times to help critters in need on her own doorstep, and we're proud to help
out more local legends in the making.

PS – did you know we also plant a tree with every order?

PAWS link: https://www.paws.org/about/

## 2026-08-18 10:47
Hi Codex, I keep asking Claude to fix Ship Ship and that whole fucking mess, and it keeps claiming it's fixed and it's not. It used to work like a month ago before we started messing with everything. I want you to get agents on *WHEN* we started changing things, *WHY*, and why we shouldn't just roll back any code changes? Amanda  [6:20 AM]
Someone in Canada is unable to order stained glass again :thinking_face:
Amanda  [6:28 AM]
Also lots of emails about people being charged shipping even over the $50 threshold (even when in just the RTS category). They're being charged $5 per item. 
LW  [10:47 AM]
thank you Claude/wildwoven-ops/paolo-compiler/compiled/people/amanda.md

## 2026-08-18 12:17
if we happen to generate free shipping we need some kind of Slack alert, I'm confused though. In what instance would shipping metadata ever not be present

## 2026-08-18 12:19
I don't believe we allow Shop Pay like that? And does our logic **work when people use the Shop app**? it used to?

## 2026-08-18 13:32
do you see these? old? Collie  [1:19 PM]
:warning: Ship Ship granted customer-safe free shipping: invalid ready-stock
Reason: Signed fulfillment-pool metadata failed verification.
Pool: ready-stock
Signed pool total: unknown
This warehouse callback subtotal: $38.00
Quote ID: missing
Customer was charged $0 to prevent a duplicate warehouse fee. Investigate the checkout path.Source
ship-ship-ratesSeverity
warning[1:24 PM]:warning: Ship Ship granted customer-safe free shipping: stale ready-stock
Reason: signed cart total 7600 does not match Shopify post-discount subtotal 6840 — cart changed after stamping
Pool: ready-stock
Signed pool total: unknown
This warehouse callback subtotal: $76.00
Quote ID: missing
Customer was charged $0 to prevent a duplicate warehouse fee. Investigate the checkout path.Source
ship-ship-ratesSeverity

## 2026-08-19 12:37
and look at all of the non shipping charges that came in. Can you verify the fix that Claude sent out is working?

## 2026-08-19 12:39
how much money have we lost on shipping today

## 2026-08-19 12:47
so what's the fix re: public app etc

## 2026-08-19 12:51
Pool classification lives on the Shopify variant as a metafield maintained
     by Batchy. It cannot depend on Hydrogen metadata, so the same rule works
     for normal Hydrogen checkout, accelerated Shop Pay, and—in principle—the
     Shop app. <-- I don't like this because metafields have to be updated and what if we forget? What if we have some sizes/variants of one product on pre-order and others are ready to ship?

## 2026-08-19 13:02
I also don't understand this:  The important limitation is that Shopify’s Discount Function does not expose
  the fulfillment location directly. It exposes cart lines, discounted costs,
  delivery groups, and delivery-option codes. Therefore the carrier code is the
  bridge—but it is calculated live, not stored on the variant. Shopify requires
  carrier service codes to be stable identifiers, which is exactly what RTS_STD
  and PO_STD are. Shopify carrier response contract
  (https://shopify.dev/docs/api/admin-graphql/latest/queries/carrierService).

## 2026-08-19 13:09
so if we expose Ship Ship as a limited app, then this works?

## 2026-08-19 14:34
:warning: Ship Ship granted customer-safe free shipping: unsigned ready-stock
Reason: No signed fulfillment-pool metadata reached the carrier.
Pool: ready-stock
Signed pool total: unknown
This warehouse callback subtotal: $36.00
Quote ID: missing
Customer was charged $0 to prevent a duplicate warehouse fee. Investigate the checkout path.Source
ship-ship-ratesSeverity
warning <-- why is this still happening as of 1:15 pm

## 2026-08-21 10:18
I'm trying to get that working for you, but there's a lot going on today. Why was someone with $30 not charged shipping jsut now at 10:07

## 2026-08-22 08:37
I just got an ad for dash.fi -- I'm most interested in their audit agents, particularly ad credit recovery, click fraud protection, AI shipping audit (getting refunds back) -- basically how could we claw back funds we should be entitled to

## 2026-08-22 08:41
yeah but we have been using Shopify shipping too, so we'd have to get tracking numbers from recently shipped orders too... I guess this would only apply to anything Cammi shipped right because we don't own the account for Calibrate shipments?

## 2026-08-22 08:42
we'd need to see what each carrier eligibity window would be

## 2026-08-22 08:56
Yeah go ahead and build us out the shipping agent, and then get more eyes on the ads credit? or whatever the other things were. more refunds

## 2026-08-22 16:27
yes it was completed through Shop Pay but I didn't get a confirmation of the split shipments, is that ok

## 2026-08-22 16:27
yes it was through Shop Pay button

## 2026-08-22 16:37
this is confusing though, if someone ends up paying it twice, for instance, they should see the break out like the original Ship Ship Behavior right? What did it look like at checkout? It was split

## 2026-08-22 16:39
we need that same behavior, based on the **original** Ship Ship shipping thing I shipped back in 2025

## 2026-08-22 16:39
it even says things are shipping in 2 shipments

## 2026-08-23 08:52
it was already on, split shipping

## 2026-08-23 14:19
Pre-Order Free Shipping Over $50

Ships next business day

Preorder shipment

$5.00

Express Shipping

Ships next business day

Acceptance-store express fixture -- this looks confusing. Can we add parenthesis? Pre-Order Shipping, then secondary line is Free over $50, preorder shipment

## 2026-08-24 09:35
so now what. And I'm confused, we don't offer express shipping

## 2026-08-24 13:36
Pre-Order Shipping

Free over $50 (preorder shipment) -- I think this should read Free Over $50 (Ships during promised arrival window) or something like that... right

## 2026-08-24 14:25
then we need to switch those onto pre-order, ships in November

## 2026-08-24 15:22
and tell her about our pre-order situation

## 2026-08-24 15:25
**if the demand goes above the capped preorder, we should also be able to accommodate it** and mention we are 90% sure that customers will have product in hand earlier than November because of our new preorder system with Portless (don't name it)

## 2026-08-24 15:26
shipping in November not Nov 30

## 2026-08-24 15:27
yes go ahead and copy Amanda. And did you verify that the batch is open and people can actively pre-order now?

## 2026-08-24 15:44
• Sent successfully from gmail:wildwoven to Jessica on the existing thread, with
  Amanda copied. The email says “shipping in November,” not November 30.

  And yes—the preorder is active now:

  - B7 is OPEN.
  - Sizes 5/6, 7/8, and 9/10 are PREORDER_OPEN.
  - All three size buttons are enabled and marked as preorder.
  - Add to Cart is enabled.
  - Current capacities are 190, 130, and 70 units.

  I couldn’t perform a literal browser checkout because the browser connection
  wasn’t available, but the live storefront and Batchy availability checks both
  passed.

