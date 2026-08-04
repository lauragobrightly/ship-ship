# Wildwoven split-shipping Function

This Shopify Discount Function is the authoritative cross-delivery-group step
for Wildwoven's domestic shipping policy:

- ready-stock and preorder merchandise have independent $50 merchandise
  thresholds;
- a qualifying pool ships free, even when Shopify splits it across locations;
- a non-qualifying pool pays one $5 fee, not one fee per location;
- other delivery methods, including express rates, are never discounted.

Hydrogen stamps preorder lines with `_shipping_bucket=preorder`. For legacy and
accelerated checkouts, the Function classifies an unstamped group from the
carrier's `PO_STD` or `RTS_STD` service code; the exact service title is a final
compatibility fallback. A group with conflicting markers or both service codes
is deliberately left unchanged because one Shopify delivery group cannot
represent two independent shipping promises.

Thresholds use each cart line's post-discount `totalAmount`, and Shopify's
presentment-currency rate converts the store-currency $50 threshold when needed.

## Activation

The extension is linked to the existing Wildwoven/Ship Ship Partner app. It must
be deployed, activated as an automatic `SHIPPING` discount, and verified in a
real checkout before a carrier release that always returns the $5 base rates.
The app needs `write_discounts`.

```bash
npm install
npm test
npm run build
```
