# Ship Ship Hooray

A variant-aware shipping rate calculator that splits cart items by pre-order status and applies different shipping rates accordingly.

## 🚀 Quick Deploy

### Railway (Recommended)
1. Fork this repository: https://github.com/lauragobrightly/ship-ship
2. Connect to [Railway](https://railway.app)
3. Add Redis database
4. Set environment variables
5. Deploy!

### Environment Variables Required
- SHOPIFY_API_KEY=your_api_key
- SHOPIFY_API_SECRET=your_api_secret
- SHOPIFY_WEBHOOK_SECRET=your_webhook_secret
- SHOPIFY_ACCESS_TOKEN=your_access_token
- SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
- APP_DOMAIN=https://your-deployed-app.com
- REDIS_URL=redis://your-redis-url

## Features
- ✅ Split shipping by variant pre-order status
- ✅ Configurable thresholds and rates  
- ✅ Kill switch for promotions
- ✅ Redis caching for performance
- ✅ Admin interface for configuration

## How It Works
1. Reads `preproduct.is_preorder` metafield on variants
2. Splits cart into "Ready-to-Ship" vs "Pre-Order" buckets
3. Applies threshold-based rates to each bucket
4. Returns up to 2 shipping options to Shopify

## Installation
1. Create Shopify app in Partners dashboard with name "Ship Ship Hooray"
2. Deploy this code to Railway/Heroku/Vercel
3. Set environment variables
4. Install on your store
5. Configure via admin interface

## Testing
```bash
npm test

See full documentation in /docs folder.
