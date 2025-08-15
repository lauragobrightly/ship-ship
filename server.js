import express from 'express';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Redis client for caching
const redis = createClient({
  url: process.env.REDIS_URL
});

redis.on('error', (err) => console.log('Redis Client Error', err));

// Connect to Redis
try {
  await redis.connect();
  console.log('Connected to Redis');
} catch (error) {
  console.error('Redis connection failed:', error);
}

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// App configuration (in production, store in database)
const appConfig = {
  threshold: 5000, // $50 in cents
  feeUnderThreshold: 500, // $5 in cents
  labels: {
    rts: "Ships Now (In-Stock)",
    po: "Ships Later (Pre-Order)"
  },
  description: "Free over $50",
  killSwitch: false, // Turn on during promos
  currency: "USD"
};

// Cache TTL (24 hours)
const CACHE_TTL = 24 * 60 * 60;

// Utility functions
function verifyWebhook(data, hmacHeader) {
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
    console.warn('SHOPIFY_WEBHOOK_SECRET not set - webhook verification disabled');
    return true;
  }
  
  const calculated = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(data, 'utf8')
    .digest('base64');
  
  return crypto.timingSafeEqual(
    Buffer.from(calculated, 'base64'),
    Buffer.from(hmacHeader, 'base64')
  );
}

async function getCachedVariantMetafield(variantId) {
  try {
    const cacheKey = `variant_po_${variantId}`;
    const cached = await redis.get(cacheKey);
    
    if (cached !== null) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn('Cache read error:', error);
  }
  
  return null;
}

async function setCachedVariantMetafield(variantId, isPreOrder) {
  try {
    const cacheKey = `variant_po_${variantId}`;
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(isPreOrder));
  } catch (error) {
    console.warn('Cache write error:', error);
  }
}

async function fetchVariantMetafields(variantIds) {
  const query = `
    query VariantMetafields($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          metafield(namespace: "preproduct", key: "is_preorder") {
            value
            type
          }
        }
      }
    }
  `;
  
  const gqlVariantIds = variantIds.map(id => `gid://shopify/ProductVariant/${id}`);
  
  const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: { ids: gqlVariantIds }
    })
  });
  
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${await response.text()}`);
  }
  
  const data = await response.json();
  return data;
}

async function getVariantPreOrderStatus(variantIds) {
  const results = new Map();
  const uncachedIds = [];
  
  // Check cache first
  for (const variantId of variantIds) {
    const cached = await getCachedVariantMetafield(variantId);
    if (cached !== null) {
      results.set(variantId, cached);
    } else {
      uncachedIds.push(variantId);
    }
  }
  
  // Fetch uncached variants in batch
  if (uncachedIds.length > 0) {
    try {
      const gqlData = await fetchVariantMetafields(uncachedIds);
      
      if (gqlData.data && gqlData.data.nodes) {
        for (const node of gqlData.data.nodes) {
          if (node) {
            const variantId = node.id.replace('gid://shopify/ProductVariant/', '');
            const isPreOrder = node.metafield ? node.metafield.value === 'true' : false;
            
            results.set(variantId, isPreOrder);
            await setCachedVariantMetafield(variantId, isPreOrder);
          }
        }
      }
      
      // Set false for any remaining uncached variants
      for (const variantId of uncachedIds) {
        if (!results.has(variantId)) {
          results.set(variantId, false);
          await setCachedVariantMetafield(variantId, false);
        }
      }
    } catch (error) {
      console.error('Error fetching variant metafields:', error);
      // Fallback: assume not pre-order
      for (const variantId of uncachedIds) {
        results.set(variantId, false);
      }
    }
  }
  
  return results;
}

// Routes

// Serve admin interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    redis: redis.isReady ? 'connected' : 'disconnected'
  });
});

// Install/setup route
app.post('/install', async (req, res) => {
  try {
    const { shop, accessToken } = req.body;
    
    if (!shop || !accessToken) {
      return res.status(400).json({ error: 'Missing shop or accessToken' });
    }
    
    // Register carrier service
    const carrierServiceResponse = await fetch(`https://${shop}/admin/api/2024-07/carrier_services.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        carrier_service: {
          name: "Ship Ship Hooray",
          callback_url: `${process.env.APP_DOMAIN}/rates`,
          service_discovery: true,
          format: "json"
        }
      })
    });
    
    if (!carrierServiceResponse.ok) {
      const errorText = await carrierServiceResponse.text();
      throw new Error(`CarrierService create failed: ${carrierServiceResponse.status} ${errorText}`);
    }
    
    const carrierService = await carrierServiceResponse.json();
    
    // Set up product update webhook
    const webhookResponse = await fetch(`https://${shop}/admin/api/2024-07/webhooks.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        webhook: {
          topic: 'products/update',
          address: `${process.env.APP_DOMAIN}/webhook/product-update`,
          format: 'json'
        }
      })
    });
    
    const webhook = webhookResponse.ok ? await webhookResponse.json() : null;
    
    res.json({
      success: true,
      carrierService,
      webhook,
      message: 'Ship Ship Hooray installed successfully'
    });
    
  } catch (error) {
    console.error('Installation error:', error);
    res.status(500).json({ 
      error: 'Installation failed',
      details: error.message 
    });
  }
});

// Main shipping rates endpoint
app.post('/rates', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Check kill switch
    if (appConfig.killSwitch) {
      return res.json({ rates: [] });
    }
    
    const { rate } = req.body;
    
    if (!rate || !rate.items) {
      return res.status(400).json({ error: 'Invalid rate request format' });
    }
    
    // Handle edge cases
    if (rate.items.length === 0) {
      return res.json({ rates: [] });
    }
    
    // Check for gift cards only
    const isGiftCardsOnly = rate.items.every(item => 
      item.product_type === 'Gift Card' || 
      item.title?.toLowerCase().includes('gift card')
    );
    
    if (isGiftCardsOnly) {
      return res.json({
        rates: [{
          service_name: "Free Shipping",
          service_code: "GIFT_CARD_FREE",
          total_price: "0",
          currency: appConfig.currency,
          description: "Gift cards ship free"
        }]
      });
    }
    
    // Get variant IDs
    const variantIds = rate.items.map(item => item.variant_id.toString());
    
    // Fetch pre-order status for all variants
    const variantStatuses = await getVariantPreOrderStatus(variantIds);
    
    // Calculate subtotals
    let rtsSubtotal = 0;
    let preorderSubtotal = 0;
    
    for (const item of rate.items) {
      const variantId = item.variant_id.toString();
      const isPreOrder = variantStatuses.get(variantId) || false;
      const extended = item.price * item.quantity; // Price is in cents, pre-discount
      
      if (isPreOrder) {
        preorderSubtotal += extended;
      } else {
        rtsSubtotal += extended;
      }
    }
    
    const rates = [];
    
    // Emit RTS rate if there are RTS items
    if (rtsSubtotal > 0) {
      const rtsPrice = rtsSubtotal >= appConfig.threshold ? 0 : appConfig.feeUnderThreshold;
      rates.push({
        service_name: appConfig.labels.rts,
        service_code: "RTS_STD",
        total_price: rtsPrice.toString(),
        currency: appConfig.currency,
        description: appConfig.description
      });
    }
    
    // Emit Pre-Order rate if there are PO items
    if (preorderSubtotal > 0) {
      const poPrice = preorderSubtotal >= appConfig.threshold ? 0 : appConfig.feeUnderThreshold;
      rates.push({
        service_name: appConfig.labels.po,
        service_code: "PO_STD",
        total_price: poPrice.toString(),
        currency: appConfig.currency,
        description: appConfig.description
      });
    }
    
    const processingTime = Date.now() - startTime;
    console.log(`Rates calculated in ${processingTime}ms for ${rate.items.length} items`);
    
    res.json({ rates });
    
  } catch (error) {
    console.error('Rate calculation error:', error);
    res.status(500).json({ 
      error: 'Rate calculation failed',
      rates: [] 
    });
  }
});

// Webhook for product updates (to invalidate cache)
app.post('/webhook/product-update', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const body = req.body;
    
    if (!verifyWebhook(body, hmac)) {
      return res.status(401).send('Unauthorized');
    }
    
    const product = JSON.parse(body.toString());
    
    // Invalidate cache for all variants of this product
    if (product.variants) {
      for (const variant of product.variants) {
        const cacheKey = `variant_po_${variant.id}`;
        try {
          await redis.del(cacheKey);
        } catch (error) {
          console.warn('Cache deletion error:', error);
        }
      }
      console.log(`Cache invalidated for product ${product.id} with ${product.variants.length} variants`);
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Configuration endpoints (for app UI)
app.get('/config', (req, res) => {
  res.json(appConfig);
});

app.post('/config', (req, res) => {
  const { threshold, feeUnderThreshold, labels, description, killSwitch } = req.body;
  
  if (threshold !== undefined) appConfig.threshold = threshold;
  if (feeUnderThreshold !== undefined) appConfig.feeUnderThreshold = feeUnderThreshold;
  if (labels) appConfig.labels = { ...appConfig.labels, ...labels };
  if (description !== undefined) appConfig.description = description;
  if (killSwitch !== undefined) appConfig.killSwitch = killSwitch;
  
  res.json({ success: true, config: appConfig });
});

// Cache stats endpoint
app.get('/cache/stats', async (req, res) => {
  try {
    if (!redis.isReady) {
      return res.status(503).json({ error: 'Redis not connected' });
    }
    
    const info = await redis.info('memory');
    const keys = await redis.keys('variant_po_*');
    
    res.json({
      redis_connected: redis.isReady,
      cached_variants: keys.length,
      cache_prefix: 'variant_po_',
      memory_info: info
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear cache endpoint
app.post('/cache/clear', async (req, res) => {
  try {
    if (!redis.isReady) {
      return res.status(503).json({ error: 'Redis not connected' });
    }
    
    const keys = await redis.keys('variant_po_*');
    if (keys.length > 0) {
      await redis.del(keys);
    }
    res.json({ cleared: keys.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (redis.isReady) {
    await redis.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (redis.isReady) {
    await redis.disconnect();
  }
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Ship Ship Hooray running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`App domain: ${process.env.APP_DOMAIN}`);
});

export default app;
