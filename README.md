# Ship Ship Hooray

Wildwoven's Shopify carrier service for ready-to-ship and preorder rates.

## Shipping rules

- Ready-to-ship groups use Shopify's full `order_totals.subtotal_price` for the $50 free-shipping threshold. Split fulfillment locations do not change qualification.
- Preorder groups qualify separately and use Batchy as the variant-status source.
- Domestic groups under their applicable threshold cost $5.
- International orders defer to Shopify's native rates.

Shopify can call `/rates` once per fulfillment group. Since November 2025, every callback includes the full cart subtotal in `order_totals`. The service uses that value directly for in-stock items instead of trying to reconstruct the cart from callbacks that can arrive seconds apart.

## Production

- Host: Railway service `ship-ship` in project `brilliant-elegance`
- URL: `https://ship-ship-production.up.railway.app`
- Deployment: GitHub auto-deploy from `main`
- Cache: in-process TTL cache

## Required environment variables

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_ACCESS_TOKEN`
- `SHOPIFY_SHOP_DOMAIN`
- `APP_DOMAIN`
- `BATCHY_API_KEY`
- `BATCHY_URL`

`CROSS_GROUP_WINDOW_MS` is optional. It controls the legacy/preorder sibling-callback fallback and defaults to 3000 ms.

## Testing

```bash
npm test
```
