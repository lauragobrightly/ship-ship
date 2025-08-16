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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic Auth middleware for admin interface
function requireAuth(req, res, next) {
  // Skip auth for API endpoints that Shopify needs to access
  const publicPaths = ['/rates', '/webhook/', '/health', '/install', '/auth'];
  const isPublicPath = publicPaths.some(path => req.path.startsWith(path));
  
  if (isPublicPath) {
    return next();
  }
  
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ship Ship Hooray Admin"');
    return res.status(401).send('Authentication required');
  }
  
  const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const username = credentials[0];
  const password = credentials[1];
  
  // Simple username/password check
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ship_ship_hooray_123';
  
  if (username === adminUsername && password === adminPassword) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ship Ship Hooray Admin"');
    res.status(401).send('Invalid credentials');
  }
}

// Apply auth to all routes except public API endpoints
app.use(requireAuth);

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

async function getCachedVariantPreOrder(variantId) {
  try {
    const cacheKey = `preproduct_variant_${variantId}`;
    const cached = await redis.get(cacheKey);
    
    if (cached !== null) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn('Cache read error:', error);
  }
  
  return null;
}

async function setCachedVariantPreOrder(variantId, isPreOrder) {
  try {
    const cacheKey = `preproduct_variant_${variantId}`;
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(isPreOrder));
  } catch (error) {
    console.warn('Cache write error:', error);
  }
}

// Get product ID from variant ID using Shopify API
async function getProductIdFromVariant(variantId) {
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07/variants/${variantId}.json`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch variant: ${response.status}`);
    }
    
    const data = await response.json();
    return data.variant.product_id;
  } catch (error) {
    console.error('Error fetching product ID for variant:', variantId, error);
    return null;
  }
}

// Call PreProduct API to check if variant is pre-order
async function fetchPreProductStatus(productId, variantId) {
  try {
    const url = `https://api.preproduct.io/api/v2/on_preorder/${productId}?any_variant=false&variant_ids=${variantId}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': process.env.PREPRODUCT_API_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`PreProduct API failed: ${response.status} ${await response.text()}`);
    }
    
const data = await response.json();

// Debug logging
console.log('PreProduct API raw response:', JSON.stringify(data));
console.log('data.on_preorder value:', data.on_preorder);

// PreProduct API returns {on_preorder: true/false}
return data.on_preorder || false;
    
  } catch (error) {
    console.error('Error calling PreProduct API:', error);
    return false; // Default to not pre-order on error
  }
}

async function getVariantPreOrderStatus(variantIds) {
  const results = new Map();
  const uncachedVariants = [];
  
  // Check cache first
  for (const variantId of variantIds) {
    const cached = await getCachedVariantPreOrder(variantId);
    if (cached !== null) {
      results.set(variantId, cached);
    } else {
      uncachedVariants.push(variantId);
    }
  }
  
  // For uncached variants, we need to:
  // 1. Get product ID from Shopify
  // 2. Call PreProduct API
  // 3. Cache the result
  for (const variantId of uncachedVariants) {
    try {
      // Get product ID for this variant
      const productId = await getProductIdFromVariant(variantId);
      
      if (productId) {
        // Call PreProduct API
        const isPreOrder = await fetchPreProductStatus(productId, variantId);
        
        // Store result and cache it
        results.set(variantId, isPreOrder);
        await setCachedVariantPreOrder(variantId, isPreOrder);
        
        console.log(`PreProduct API: Variant ${variantId} (Product ${productId}) is ${isPreOrder ? 'pre-order' : 'ready-to-ship'}`);
      } else {
        // Fallback: assume not pre-order if we can't get product ID
        results.set(variantId, false);
        await setCachedVariantPreOrder(variantId, false);
      }
    } catch (error) {
      console.error('Error processing variant:', variantId, error);
      // Fallback: assume not pre-order on error
      results.set(variantId, false);
    }
  }
  
  return results;
}

// Routes

// OAuth initiation route (optional - for manual installs)
app.get('/auth', (req, res) => {
  const { shop } = req.query;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  const scopes = 'read_products,write_shipping,write_products';
  const redirectUri = `${process.env.APP_DOMAIN}/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  
  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${process.env.SHOPIFY_API_KEY}&` +
    `scope=${scopes}&` +
    `redirect_uri=${redirectUri}&` +
    `state=${state}`;
  
  res.redirect(authUrl);
});

// OAuth callback route - handles Shopify's response after authorization
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, hmac, shop, state } = req.query;
    
    if (!code || !shop) {
      return res.status(400).send('Missing required parameters');
    }
    
    // Verify HMAC (security check)
    const queryString = Object.keys(req.query)
      .filter(key => key !== 'hmac')
      .map(key => `${key}=${req.query[key]}`)
      .sort()
      .join('&');
    
    const calculatedHmac = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(queryString)
      .digest('hex');
    
    if (calculatedHmac !== hmac) {
      return res.status(401).send('Invalid HMAC');
    }
    
    // Exchange authorization code for access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: code
      })
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    console.log(`✅ OAuth successful for shop: ${shop}`);
    console.log(`🔑 Access token received: ${accessToken.substring(0, 10)}...`);
    
    // Now install the carrier service and webhooks
    try {
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
        console.error('Carrier service registration failed:', errorText);
      } else {
        console.log('✅ Carrier service registered successfully');
      }
      
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
      
      if (webhookResponse.ok) {
        console.log('✅ Webhook registered successfully');
      }
      
    } catch (installError) {
      console.error('Post-installation setup error:', installError);
    }
    
    // Show success page with access token
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Ship Ship Hooray - Installation Complete!</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                 padding: 40px; background: #f8f9fa; }
          .container { max-width: 600px; margin: 0 auto; background: white; 
                      padding: 40px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          h1 { color: #2c5aa0; margin-bottom: 20px; }
          .success { background: #d4edda; color: #155724; padding: 15px; 
                    border-radius: 4px; margin: 20px 0; }
          .token-box { background: #f8f9fa; padding: 15px; border-radius: 4px; 
                      font-family: monospace; word-break: break-all; margin: 20px 0; }
          .next-steps { background: #e7f3ff; padding: 20px; border-radius: 4px; }
          a { color: #2c5aa0; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚢 Ship Ship Hooray Installation Complete!</h1>
          
          <div class="success">
            ✅ Successfully installed on <strong>${shop}</strong><br>
            ✅ Carrier service "Ship Ship Hooray" registered<br>
            ✅ Product update webhook configured<br>
            ✅ Ready to calculate shipping rates!
          </div>
          
          <h3>🔑 Access Token</h3>
          <p>Add this access token to your Railway environment variables:</p>
          <div class="token-box">
            SHOPIFY_ACCESS_TOKEN=${accessToken}
          </div>
          
          <div class="next-steps">
            <h3>📋 Next Steps:</h3>
            <ol>
              <li><strong>Add the access token</strong> to your Railway environment variables</li>
              <li><strong>Test the app:</strong> <a href="${process.env.APP_DOMAIN}" target="_blank">Visit Admin Interface</a></li>
              <li><strong>Test shipping rates:</strong> Add items to cart and go to checkout</li>
              <li><strong>Configure settings:</strong> Adjust thresholds and labels in admin</li>
            </ol>
          </div>
          
          <p style="margin-top: 30px; text-align: center;">
            <a href="https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}" target="_blank">
              ← Back to Shopify Admin
            </a>
          </p>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <h1>Installation Error</h1>
      <p>Something went wrong during installation: ${error.message}</p>
      <p><a href="javascript:history.back()">← Go Back</a></p>
    `);
  }
});

// Serve admin interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    redis: redis.isReady ? 'connected' : 'disconnected',
    preproduct_api: process.env.PREPRODUCT_API_TOKEN ? 'configured' : 'missing'
  });
});

// Install/setup route (legacy - OAuth callback handles this now)
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
    
    // Fetch pre-order status for all variants from PreProduct
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
    console.log(`RTS subtotal: $${rtsSubtotal/100}, PO subtotal: $${preorderSubtotal/100}`);
    
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
        const cacheKey = `preproduct_variant_${variant.id}`;
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
    const keys = await redis.keys('preproduct_variant_*');
    
    res.json({
      redis_connected: redis.isReady,
      cached_variants: keys.length,
      cache_prefix: 'preproduct_variant_',
      memory_info: info,
      preproduct_api: process.env.PREPRODUCT_API_TOKEN ? 'configured' : 'missing'
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
    
    const keys = await redis.keys('preproduct_variant_*');
    if (keys.length > 0) {
      await redis.del(keys);
    }
    res.json({ cleared: keys.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test PreProduct API endpoint (for debugging)
app.get('/test-preproduct/:productId/:variantId', async (req, res) => {
  try {
    const { productId, variantId } = req.params;
    const isPreOrder = await fetchPreProductStatus(productId, variantId);
    
    res.json({
      productId,
      variantId,
      isPreOrder,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      productId: req.params.productId,
      variantId: req.params.variantId
    });
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
  console.log(`PreProduct API: ${process.env.PREPRODUCT_API_TOKEN ? 'Configured' : 'Missing'}`);
});

export default app;
