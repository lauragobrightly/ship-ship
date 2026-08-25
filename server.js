import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendAlert, startWatchdogs } from './watchdog.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// In-memory cache with TTL support
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlSeconds) {
  // Clear any existing timer for this key
  const existing = cache.get(key);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => cache.delete(key), ttlSeconds * 1000);
  timer.unref?.();
  cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, timer });
}

function cacheDel(key) {
  const entry = cache.get(key);
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
  }
  cache.delete(key);
}

function cacheKeys(pattern) {
  // Simple glob-style pattern matching (supports trailing *)
  const prefix = pattern.replace(/\*$/, '');
  const keys = [];
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      const entry = cache.get(key);
      // Skip expired entries
      if (entry && Date.now() <= entry.expiresAt) {
        keys.push(key);
      }
    }
  }
  return keys;
}

console.log('In-memory cache initialized');

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
  feeUnderThreshold: 699, // $6.99 in cents
  labels: {
    rts: "Ships Now (In-Stock)",
    po: "Ships Later (Pre-Order)",
    promo: "Mystery Box Shipping"
  },
  descriptions: {
    rts: "Ready to ship",
    po: "Free over $50",
    promo: "Flat rate per order"
  },
  promotion: {
    enabled: false,
    flatRate: 695, // $6.95 in cents
    tag: "mysterybox"
  },
  killSwitch: false, // Turn on during promos
  currency: "USD"
};

// Cache TTL (15 minutes — short enough to pick up Batchy status changes quickly)
const CACHE_TTL = 15 * 60;

// Cache TTL for product data (1 hour)
const PRODUCT_CACHE_TTL = 3600;

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
  const cacheKey = `preproduct_variant_${variantId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return cached;
  }
  return null;
}

async function setCachedVariantPreOrder(variantId, isPreOrder) {
  const cacheKey = `preproduct_variant_${variantId}`;
  cacheSet(cacheKey, isPreOrder, CACHE_TTL);
}

// Helper function to get cached product data
async function getCachedProductData(productId) {
  const cacheKey = `product_data_${productId}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch from Shopify API
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-07/products/${productId}.json`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      }
    });

    if (response.ok) {
      const data = await response.json();
      const productData = {
        title: data.product.title,
        tags: data.product.tags || ''
      };

      // Cache the result
      cacheSet(cacheKey, productData, PRODUCT_CACHE_TTL);

      return productData;
    }
  } catch (error) {
    console.error(`Error fetching product ${productId}:`, error);
  }

  return null;
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

// Call Batchy API to check if variant is pre-order
async function fetchPreProductStatus(productId, variantId) {
  const batchyUrl = process.env.BATCHY_URL || 'https://batchy-production-0e03.up.railway.app';
  const batchyApiKey = process.env.BATCHY_API_KEY;

  try {
    const url = `${batchyUrl}/api/v1/variant-status/${productId}/${variantId}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${batchyApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Batchy API failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();

    // Debug logging
    console.log('Batchy API raw response:', JSON.stringify(data));
    console.log('data.isPreOrder value:', data.isPreOrder);

    // Batchy API returns {isPreOrder: true/false, status: "IN_STOCK"|"PREORDER_OPEN"|etc.}
    return data.isPreOrder || false;

  } catch (error) {
    console.error('Error calling Batchy API:', error);
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

function itemProperty(item, key) {
  const properties = item?.properties;
  if (Array.isArray(properties)) {
    const match = properties.find((property) =>
      (property?.key ?? property?.name) === key
    );
    return match?.value ?? null;
  }
  if (properties && typeof properties === 'object') {
    return properties[key] ?? null;
  }
  return null;
}

async function classifyPreOrderItems(items) {
  const result = new Map();
  const unresolvedVariantIds = [];

  for (const item of items) {
    const variantId = item.variant_id.toString();
    if (itemProperty(item, '_shipping_bucket') === 'preorder') {
      result.set(variantId, true);
    } else {
      unresolvedVariantIds.push(variantId);
    }
  }

  if (unresolvedVariantIds.length > 0) {
    const fetched = await getVariantPreOrderStatus([...new Set(unresolvedVariantIds)]);
    for (const variantId of unresolvedVariantIds) {
      // A duplicate unstamped line must never overwrite an affirmative marker
      // carried by another line for the same variant.
      if (result.get(variantId) !== true) {
        result.set(variantId, fetched.get(variantId) || false);
      }
    }
  }

  return result;
}

function parseUnsignedInteger(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Rebuild Hydrogen's signed payload.
 *
 * `version` selects the contract, and `quantity` means different things under
 * each: under v1 it is the quantity Shopify sent in this callback, under v2 it
 * is the cart line's own full quantity published as `_ww_ship_qty`. Both shapes
 * must stay supported — the storefront and this service deploy independently,
 * so carts signed under either version are in flight during the rollout.
 */
const SUPPORTED_QUOTE_VERSIONS = ['1', '2'];

function quoteSignaturePayload({
  version,
  quoteId,
  bucket,
  poolCents,
  cartCents,
  currency,
  productId,
  variantId,
  quantity,
  anchor,
}) {
  return [
    version, quoteId, bucket, poolCents, cartCents, currency,
    productId, variantId, quantity, anchor ? '1' : '0',
  ].join('|');
}

function signaturesMatch(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(String(actual ?? ''))) return false;
  const actualBuffer = Buffer.from(String(actual), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Identify an item in a log line without leaking the signature or the secret. */
function quoteItemLabel(item) {
  return [
    `sku=${item?.sku ? String(item.sku) : 'n/a'}`,
    `variant=${item?.variant_id ?? 'n/a'}`,
    `product=${item?.product_id ?? 'n/a'}`,
  ].join(' ');
}

/**
 * Log why a signed quote was rejected, then return null.
 *
 * Every rejection is surfaced to the customer-safe fallback and Slack alert.
 * A malformed quote must never recreate per-warehouse charges merely because
 * the carrier cannot distinguish tampering from a broken checkout contract.
 */
function rejectSignedQuote(bucket, reason, item) {
  const where = item ? ` [${quoteItemLabel(item)}]` : '';
  console.warn(`Signed ${bucket} quote rejected — ${reason}${where}`);
  return null;
}

/**
 * A structurally honest quote that is merely out of date — distinct from a
 * rejection. Rejection means tamper-shaped evidence (bad HMAC, inflated
 * quantity, disagreeing pools). Stale means the cart moved on after stamping,
 * which honest carts do constantly:
 *
 *   - a discount code makes Hydrogen's signed post-discount subtotal differ
 *     from Shopify's pre-discount `order_totals.subtotal_price` unless the
 *     callback's `discount_amount` is applied, and
 *   - an express checkout can add a line after the last re-stamp, leaving one
 *     line of the group unstamped.
 *
 * A stale quote fails customer-safe. A single carrier callback cannot know
 * whether another warehouse holds the rest of the same pool, so charging that
 * callback independently can create the exact per-warehouse overcharge this
 * service exists to prevent. Hydrogen refreshes stamps synchronously at the
 * checkout bridge; stale or unstamped callbacks are therefore exceptional and
 * ship free while logs surface the lost revenue for repair.
 */
export const STALE_QUOTE = Object.freeze({stale: true});

function staleSignedQuote(bucket, reason, item, quote = {}) {
  const where = item ? ` [${quoteItemLabel(item)}]` : '';
  console.warn(`Signed ${bucket} quote stale — ${reason}${where} — failing customer-safe at $0`);
  return {...STALE_QUOTE, ...quote, reason};
}

/**
 * Verify Hydrogen's signed whole-pool quote for one carrier delivery group.
 * Returns null for unstamped or rejected metadata and STALE_QUOTE for honest
 * staleness. The caller distinguishes those outcomes before setting a price.
 */
export function verifySignedShippingQuote(items, bucket, rate, secret = process.env.BATCHY_API_KEY) {
  if (!Array.isArray(items) || items.length === 0) return null;
  // An entirely unstamped group is the ordinary legacy/accelerated-checkout
  // path, not a failure. Stay quiet so the warnings below stay meaningful,
  // and check the secret only once there is a signature that needs it.
  if (!hasShippingQuoteMetadata(items)) return null;
  if (!secret) return rejectSignedQuote(bucket, 'BATCHY_API_KEY is not configured');

  let common = null;
  let anchorCount = 0;
  let completeAnchorCount = 0;

  for (const item of items) {
    const version = String(itemProperty(item, '_ww_ship_v') ?? '');
    const quoteId = String(itemProperty(item, '_ww_ship_quote') ?? '');
    const quotedBucket = String(itemProperty(item, '_ww_ship_pool') ?? '');
    const poolCents = parseUnsignedInteger(itemProperty(item, '_ww_ship_pool_cents'));
    const cartCents = parseUnsignedInteger(itemProperty(item, '_ww_ship_cart_cents'));
    const currency = String(itemProperty(item, '_ww_ship_currency') ?? '').toUpperCase();
    const anchorValue = String(itemProperty(item, '_ww_ship_anchor') ?? '');
    const signature = itemProperty(item, '_ww_ship_sig');
    const productId = String(item?.product_id ?? '');
    const variantId = String(item?.variant_id ?? '');
    const quantity = parseUnsignedInteger(item?.quantity);

    // A line with no version stamp inside an otherwise-stamped group is the
    // signature of a post-stamp addition (express checkout racing the async
    // re-stamp), and an unknown version is a contract this build cannot judge.
    // Neither is tamper evidence — fail customer-safe.
    if (!SUPPORTED_QUOTE_VERSIONS.includes(version)) {
      if (version === '') {
        return staleSignedQuote(
          bucket,
          'a line in this group carries no quote stamp (added after stamping?)',
          item,
        );
      }
      return rejectSignedQuote(bucket, `unsupported _ww_ship_v "${version}"`, item);
    }

    const shapeFailure =
      (!quoteId && 'missing _ww_ship_quote') ||
      (quotedBucket !== bucket && `_ww_ship_pool "${quotedBucket}" does not match delivery group bucket "${bucket}"`) ||
      (poolCents === null && 'malformed _ww_ship_pool_cents') ||
      (cartCents === null && 'malformed _ww_ship_cart_cents') ||
      (!currency && 'missing _ww_ship_currency') ||
      (!['0', '1'].includes(anchorValue) && 'malformed _ww_ship_anchor') ||
      (!productId && 'missing product_id') ||
      (!variantId && 'missing variant_id') ||
      ((quantity === null || quantity < 1) && 'malformed callback quantity');
    if (shapeFailure) return rejectSignedQuote(bucket, shapeFailure, item);

    // v1 bound the signature to the callback quantity, which Shopify reduces
    // when it splits a cart line across fulfilment locations. v2 signs the
    // line's own quantity instead and bounds the callback by it: a split can
    // only ever shrink a group's quantity, so `callbackQty <= signedQty` keeps
    // the signature pinned to a specific quantity of a specific variant.
    const signedQuantity = version === '2'
      ? parseUnsignedInteger(itemProperty(item, '_ww_ship_qty'))
      : quantity;
    if (signedQuantity === null || signedQuantity < 1) {
      return rejectSignedQuote(bucket, 'missing or malformed _ww_ship_qty on a v2 quote', item);
    }
    if (quantity > signedQuantity) {
      return rejectSignedQuote(
        bucket,
        `callback quantity ${quantity} exceeds signed quantity ${signedQuantity}`,
        item,
      );
    }

    const anchor = anchorValue === '1';
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(quoteSignaturePayload({
        version, quoteId, bucket, poolCents, cartCents, currency,
        productId, variantId, quantity: signedQuantity, anchor,
      }))
      .digest('hex');
    if (!signaturesMatch(signature, expectedSignature)) {
      return rejectSignedQuote(bucket, `v${version} HMAC mismatch`, item);
    }

    const itemCommon = {quoteId, bucket, poolCents, cartCents, currency};
    if (common && JSON.stringify(common) !== JSON.stringify(itemCommon)) {
      return rejectSignedQuote(
        bucket,
        `items disagree on the pool quote (${JSON.stringify(common)} vs ${JSON.stringify(itemCommon)})`,
        item,
      );
    }
    common = itemCommon;
    if (anchor) {
      anchorCount++;
      if (quantity === signedQuantity) completeAnchorCount++;
    }
  }

  if (anchorCount > 1) {
    return rejectSignedQuote(bucket, `${anchorCount} anchor lines in one delivery group, expected at most 1`);
  }
  // Hydrogen stamps `_ww_ship_cart_cents` from `cart.cost.subtotalAmount` at
  // cart mutation and again synchronously at /checkout. A discount code the
  // customer types into hosted Shopify checkout is entered AFTER both of those
  // moments, so Hydrogen never sees it and the signed total stays pre-discount.
  // Shopify documents carrier `subtotal_price` as pre-discount and supplies
  // `discount_amount` separately, so one unchanged cart can legitimately
  // present as either figure depending on when it was stamped:
  //
  //   discount already in the Hydrogen cart -> signed total is post-discount;
  //   discount typed into hosted checkout   -> signed total is pre-discount.
  //
  // Accept either. A cart that genuinely changed after stamping — a line added,
  // removed, or re-quantified — matches NEITHER, so the freshness guarantee is
  // unchanged; only the false positive goes away.
  //
  // Comparing solely against the post-discount figure made every discounted
  // checkout stale, and since b70e7f2 a stale quote ships free. That is why
  // under-$50 carts with a discount code began shipping for $0 on 2026-08-18.
  const orderSubtotal = parseUnsignedInteger(rate?.order_totals?.subtotal_price);
  const orderDiscount = parseUnsignedInteger(rate?.order_totals?.discount_amount ?? 0);
  const effectiveOrderSubtotal = orderSubtotal !== null && orderDiscount !== null
    ? Math.max(0, orderSubtotal - orderDiscount)
    : null;
  const acceptedCartTotals = [orderSubtotal, effectiveOrderSubtotal].filter((v) => v !== null);
  const rateCurrency = String(rate?.currency ?? '').toUpperCase();
  if (!acceptedCartTotals.includes(common.cartCents)) {
    return staleSignedQuote(
      bucket,
      `signed cart total ${common.cartCents} matches neither Shopify's pre-discount subtotal `
        + `${orderSubtotal === null ? '(absent/malformed)' : orderSubtotal} nor its post-discount subtotal `
        + `${effectiveOrderSubtotal === null ? '(absent/malformed)' : effectiveOrderSubtotal} — cart changed after stamping`,
      null,
      {...common, effectiveOrderSubtotal},
    );
  }
  if (rateCurrency && rateCurrency !== common.currency) {
    return rejectSignedQuote(bucket, `signed currency ${common.currency} does not match rate currency ${rateCurrency}`);
  }

  // Allocate any cart-wide discount across the pools in proportion to their
  // share of the signed cart. For a percentage discount that is exact — 20% off
  // takes 20% off every pool — and for a fixed-amount discount it reproduces
  // Shopify's own `across` allocation. Of the last 88 real discount
  // applications on this store, 87 were percentage and the single fixed-amount
  // one was a manual adjustment, so this is exact for essentially all traffic.
  //
  // Only subtract when the signed totals are the PRE-discount ones. If the
  // discount was already in the Hydrogen cart at stamping time, `poolCents` is
  // post-discount already and subtracting again would double-count it.
  const signedIsPreDiscount = common.cartCents === orderSubtotal;
  const cartDiscount = signedIsPreDiscount && effectiveOrderSubtotal !== null
    ? Math.max(0, orderSubtotal - effectiveOrderSubtotal)
    : 0;
  const poolShare = common.cartCents > 0 ? common.poolCents / common.cartCents : 0;
  const effectivePoolCents = Math.max(0, Math.round(common.poolCents - cartDiscount * poolShare));

  return {
    ...common,
    effectiveOrderSubtotal,
    effectivePoolCents,
    hasAnchor: anchorCount === 1,
    // A quantity-split line copies its anchor into more than one warehouse
    // callback. No callback may charge it unless that callback contains the
    // complete signed line, or the customer can pay the same pool fee twice.
    hasCompleteAnchor: completeAnchorCount === 1,
  };
}

export function priceForSignedPool(quote, threshold = appConfig.threshold) {
  if (!quote) return null;
  if (quote.stale) return 0;
  // Price the pool on what the customer actually pays. `effectivePoolCents`
  // is the post-discount value for a single-pool cart and falls back to the
  // signed pre-discount value when the discount cannot be attributed.
  const poolValue = quote.effectivePoolCents ?? quote.poolCents;
  if (poolValue >= threshold) return 0;
  return (quote.hasCompleteAnchor ?? quote.hasAnchor)
    ? appConfig.feeUnderThreshold
    : 0;
}

export function customerSafeFallbackKind(quoteResult, invalidQuote, threshold = appConfig.threshold) {
  if (invalidQuote) return 'invalid';
  if (!quoteResult) return 'unsigned';
  if (quoteResult.stale) {
    // A discount applied inside hosted checkout legitimately changes the cart
    // total after Hydrogen stamps it. When the signed cart contained exactly
    // this one pool and both the signed pool and Shopify's newer post-discount
    // total still clear $50, free shipping is certain—not a safety waiver.
    // Stay silent. Mixed carts and threshold crossings remain alert-worthy
    // because a carrier callback cannot allocate Shopify's cart-wide discount
    // back to each fulfillment pool.
    const singlePoolCart = quoteResult.poolCents === quoteResult.cartCents;
    const stillQualifies = Number.isFinite(quoteResult.poolCents)
      && quoteResult.poolCents >= threshold
      && Number.isFinite(quoteResult.effectiveOrderSubtotal)
      && quoteResult.effectiveOrderSubtotal >= threshold;
    return singlePoolCart && stillQualifies ? null : 'stale';
  }
  if (
    quoteResult.poolCents < threshold &&
    quoteResult.hasAnchor &&
    !quoteResult.hasCompleteAnchor
  ) {
    return 'split-anchor';
  }
  return null;
}

const fallbackAlertTimes = new Map();
const FALLBACK_ALERT_COOLDOWN_MS = 15 * 60_000;

function alertCustomerSafeFallback({bucket, kind, quoteResult, groupSubtotal, suppress}) {
  if (!kind || suppress || process.env.FALLBACK_ALERTS_ENABLED === 'false') return;

  const quoteKey = quoteResult?.quoteId || 'no-quote';
  const dedupeKey = `${bucket}:${kind}:${quoteKey}`;
  const now = Date.now();
  const lastSent = fallbackAlertTimes.get(dedupeKey) || 0;
  if (now - lastSent < FALLBACK_ALERT_COOLDOWN_MS) return;
  fallbackAlertTimes.set(dedupeKey, now);

  const reason = kind === 'unsigned'
    ? 'No signed fulfillment-pool metadata reached the carrier.'
    : kind === 'invalid'
      ? 'Signed fulfillment-pool metadata failed verification.'
    : kind === 'stale'
      ? quoteResult.reason
      : 'Shopify divided the under-$50 fee-anchor line across warehouse groups.';
  const poolTotal = Number.isFinite(quoteResult?.poolCents)
    ? `$${(quoteResult.poolCents / 100).toFixed(2)}`
    : 'unknown';

  void sendAlert({
    title: `Ship Ship granted customer-safe free shipping: ${kind} ${bucket}`,
    body: [
      `Reason: ${reason}`,
      `Pool: ${bucket}`,
      `Signed pool total: ${poolTotal}`,
      `This warehouse callback subtotal: $${(groupSubtotal / 100).toFixed(2)}`,
      `Quote ID: ${quoteResult?.quoteId || 'missing'}`,
      'Customer was charged $0 to prevent a duplicate warehouse fee. Investigate the checkout path.',
    ].join('\n'),
    severity: 'warning',
    source: 'ship-ship-rates',
  });
}

function hasShippingQuoteMetadata(items) {
  return items.some((item) => itemProperty(item, '_ww_ship_v') !== null);
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
          
          <div class="next-steps">
            <h3>📋 Next Steps:</h3>
            <ol>
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
    cache: 'in-memory',
    batchy_api: process.env.BATCHY_API_KEY ? 'configured' : 'missing',
    batchy_url: process.env.BATCHY_URL || 'https://batchy-production-0e03.up.railway.app'
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

    // International orders: return empty rates so Shopify uses its native
    // international shipping profiles. No pre-order splitting for international.
    const destCountry = rate.destination?.country || rate.destination?.country_code || '';
    if (destCountry && destCountry !== 'US') {
      console.log(`International order (${destCountry}) — deferring to Shopify native rates`);
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

    // Check for mystery box items first (if promotion is enabled)
    if (appConfig.promotion.enabled) {
      const mysteryBoxItems = [];
      const nonMysteryBoxItems = [];
      
      // Get unique product IDs to minimize API calls
      const uniqueProductIds = [...new Set(rate.items.map(item => item.product_id))];
      
      // Fetch product data (with caching) for unique products
      const productDataMap = new Map();
      const productPromises = uniqueProductIds.map(async (productId) => {
        const productData = await getCachedProductData(productId);
        if (productData) {
          productDataMap.set(productId, productData);
        }
        return productData;
      });
      
      await Promise.all(productPromises);
      
      // Check each item for mystery box tag using cached product data
      for (const item of rate.items) {
        const productData = productDataMap.get(item.product_id);
        let isMysteryBox = false;
        
        if (productData) {
          // Check product tags for mystery box
          const productTags = productData.tags ? productData.tags.split(',').map(tag => tag.trim().toLowerCase()) : [];
          isMysteryBox = productTags.some(tag => 
            tag.includes('mysterybox') || 
            tag.includes('mystery-box') || 
            tag.includes('mystery box')
          );
          
          // Also check product title as fallback
          if (!isMysteryBox) {
            const titleLower = productData.title.toLowerCase();
            isMysteryBox = titleLower.includes('mystery box') || titleLower.includes('mysterybox');
          }
        }
        
        // Fallback: check item title if we couldn't get product data
        if (!isMysteryBox && !productData) {
          const itemTitleLower = item.title.toLowerCase();
          isMysteryBox = itemTitleLower.includes('mystery box') || itemTitleLower.includes('mysterybox');
        }
        
        if (isMysteryBox) {
          mysteryBoxItems.push(item);
        } else {
          nonMysteryBoxItems.push(item);
        }
      }
      
      // If ANY items are mystery boxes, return only the flat rate promotion shipping
      if (mysteryBoxItems.length > 0) {
        const processingTime = Date.now() - startTime;
        console.log(`Mystery Box cart detected (${mysteryBoxItems.length} mystery box items, ${nonMysteryBoxItems.length} regular items) in ${processingTime}ms`);
        
        return res.json({
          rates: [{
            service_name: appConfig.labels.promo,
            service_code: "MYSTERY_BOX_FLAT",
            total_price: appConfig.promotion.flatRate.toString(),
            currency: appConfig.currency,
            description: appConfig.descriptions.promo
          }]
        });
      }
      
      // If no mystery box items, continue with normal RTS/PO logic below
    }
    
    // Prefer Hydrogen's affirmative preorder marker, then fall back to Batchy
    // for accelerated checkouts and legacy carts.
    const variantStatuses = await classifyPreOrderItems(rate.items);

    // Calculate subtotals for THIS delivery group
    let rtsSubtotal = 0;
    let preorderSubtotal = 0;
    const rtsItems = [];
    const preorderItems = [];

    for (const item of rate.items) {
      const variantId = item.variant_id.toString();
      const isPreOrder = variantStatuses.get(variantId) || false;
      const extended = item.price * item.quantity; // Price is in cents, pre-discount

      if (isPreOrder) {
        preorderSubtotal += extended;
        preorderItems.push(item);
      } else {
        rtsSubtotal += extended;
        rtsItems.push(item);
      }
    }

    const rtsQuoteResult = rtsItems.length > 0
      ? verifySignedShippingQuote(rtsItems, 'ready-stock', rate)
      : null;
    const preorderQuoteResult = preorderItems.length > 0
      ? verifySignedShippingQuote(preorderItems, 'preorder', rate)
      : null;
    // Four verification outcomes:
//   verified — the signed pool prices the group;
//   stale    — honest quote, cart moved on (discount code, post-stamp
    //              addition): fail customer-safe at $0;
    //   rejected — malformed or tamper-shaped (bad HMAC, inflated qty, two
    //              anchors...): fail customer-safe at $0 and alert;
    //   unsigned — accelerated/legacy checkout: fail customer-safe at $0 because
    //              a callback cannot know how many warehouses share its pool.
    const rtsQuote = rtsQuoteResult && !rtsQuoteResult.stale ? rtsQuoteResult : null;
    const preorderQuote = preorderQuoteResult && !preorderQuoteResult.stale ? preorderQuoteResult : null;
    // A callback cannot distinguish a malicious quote from a broken/stale
    // storefront contract while also guaranteeing that physical warehouses
    // never multiply the fee. During this customer-safe bridge every rejected
    // quote therefore ships free and alerts; the public Discount Function is
    // the durable enforcement layer that removes this tradeoff.
    const invalidRtsQuote = rtsItems.length > 0 &&
      hasShippingQuoteMetadata(rtsItems) && !rtsQuoteResult;
    const invalidPreorderQuote = preorderItems.length > 0 &&
      hasShippingQuoteMetadata(preorderItems) && !preorderQuoteResult;
    const suppressFallbackAlerts = req.get('x-ship-ship-probe') === 'matrix';

    const rates = [];

    // Emit RTS rate if there are RTS items
    // Use combinedRtsTotal for threshold check (cross-location aware)
    if (rtsSubtotal > 0) {
      const signedPrice = priceForSignedPool(rtsQuote);
      if (invalidRtsQuote) {
        console.warn(`Invalid ready-stock quote — charging $0 and alerting because warehouse groups cannot price independently. `
          + `Group items subtotal $${rtsSubtotal / 100}.`);
      }
      const rtsPrice = invalidRtsQuote ? 0 : signedPrice ?? 0;
      const fallbackKind = customerSafeFallbackKind(rtsQuoteResult, invalidRtsQuote);
      alertCustomerSafeFallback({
        bucket: 'ready-stock',
        kind: fallbackKind,
        quoteResult: rtsQuoteResult,
        groupSubtotal: rtsSubtotal,
        suppress: suppressFallbackAlerts,
      });
      if (!rtsQuoteResult && !invalidRtsQuote) {
        console.warn('Unsigned ready-stock callback — charging $0 because warehouse groups cannot price independently');
      }
      rates.push({
        service_name: appConfig.labels.rts,
        service_code: "RTS_STD",
        total_price: rtsPrice.toString(),
        currency: appConfig.currency,
        description: appConfig.descriptions.rts
      });
    }

    // Emit Pre-Order rate if there are PO items
    // Use combinedPoTotal for threshold check (cross-location aware)
    if (preorderSubtotal > 0) {
      const signedPrice = priceForSignedPool(preorderQuote);
      if (invalidPreorderQuote) {
        console.warn(`Invalid preorder quote — charging $0 and alerting because warehouse groups cannot price independently. `
          + `Group items subtotal $${preorderSubtotal / 100}.`);
      }
      const poPrice = invalidPreorderQuote ? 0 : signedPrice ?? 0;
      const fallbackKind = customerSafeFallbackKind(preorderQuoteResult, invalidPreorderQuote);
      alertCustomerSafeFallback({
        bucket: 'preorder',
        kind: fallbackKind,
        quoteResult: preorderQuoteResult,
        groupSubtotal: preorderSubtotal,
        suppress: suppressFallbackAlerts,
      });
      if (!preorderQuoteResult && !invalidPreorderQuote) {
        console.warn('Unsigned preorder callback — charging $0 because warehouse groups cannot price independently');
      }
      rates.push({
        service_name: appConfig.labels.po,
        service_code: "PO_STD",
        total_price: poPrice.toString(),
        currency: appConfig.currency,
        description: appConfig.descriptions.po
      });
    }

    const processingTime = Date.now() - startTime;
    console.log(`Rates calculated in ${processingTime}ms for ${rate.items.length} items`);
    const quoteSource = rtsQuote || preorderQuote
      ? 'signed Hydrogen fulfillment-pool quote'
      : 'customer-safe unsigned fallback';
    console.log(`RTS group subtotal: $${rtsSubtotal/100}, PO group subtotal: $${preorderSubtotal/100} (${quoteSource})`);
    
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
        cacheDel(`preproduct_variant_${variant.id}`);
      }
      console.log(`Cache invalidated for product ${product.id} with ${product.variants.length} variants`);
    }

    // Invalidate product cache for mystery box detection
    cacheDel(`product_data_${product.id}`);
    console.log(`Product cache invalidated for product ${product.id}`);
    
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
  const { threshold, feeUnderThreshold, labels, descriptions, promotion, killSwitch } = req.body;
  
  if (threshold !== undefined) appConfig.threshold = threshold;
  if (feeUnderThreshold !== undefined) appConfig.feeUnderThreshold = feeUnderThreshold;
  if (labels) appConfig.labels = { ...appConfig.labels, ...labels };
  if (descriptions) appConfig.descriptions = { ...appConfig.descriptions, ...descriptions };
  if (promotion) appConfig.promotion = { ...appConfig.promotion, ...promotion };
  if (killSwitch !== undefined) appConfig.killSwitch = killSwitch;
  
  res.json({ success: true, config: appConfig });
});

// Cache stats endpoint
app.get('/cache/stats', async (req, res) => {
  try {
    const variantKeys = cacheKeys('preproduct_variant_*');
    const productKeys = cacheKeys('product_data_*');

    res.json({
      cache_type: 'in-memory',
      total_entries: cache.size,
      cached_variants: variantKeys.length,
      cached_products: productKeys.length,
      cache_prefixes: ['preproduct_variant_', 'product_data_'],
      batchy_api: process.env.BATCHY_API_KEY ? 'configured' : 'missing'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear cache endpoint
app.post('/cache/clear', async (req, res) => {
  try {
    const variantKeys = cacheKeys('preproduct_variant_*');
    const productKeys = cacheKeys('product_data_*');
    const allKeys = [...variantKeys, ...productKeys];

    for (const key of allKeys) {
      cacheDel(key);
    }

    res.json({
      cleared: allKeys.length,
      variants: variantKeys.length,
      products: productKeys.length
    });
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

// Test endpoint for mystery box detection (with caching)
app.get('/test-product-detection/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    
    // Use the same cached function as the main logic
    const productData = await getCachedProductData(productId);
    
    if (!productData) {
      throw new Error('Product not found or API error');
    }
    
    // Check for mystery box detection using same logic as main function
    let isMysteryBox = false;
    let detectionMethod = 'none';
    
    // Check product tags
    const productTags = productData.tags ? productData.tags.split(',').map(tag => tag.trim().toLowerCase()) : [];
    const hasTagMatch = productTags.some(tag => 
      tag.includes('mysterybox') || 
      tag.includes('mystery-box') || 
      tag.includes('mystery box')
    );
    
    // Check product title
    const titleLower = productData.title.toLowerCase();
    const hasTitleMatch = titleLower.includes('mystery box') || titleLower.includes('mysterybox');
    
    if (hasTagMatch && hasTitleMatch) {
      isMysteryBox = true;
      detectionMethod = 'Both tag and title';
    } else if (hasTagMatch) {
      isMysteryBox = true;
      detectionMethod = 'Product tag';
    } else if (hasTitleMatch) {
      isMysteryBox = true;
      detectionMethod = 'Product title';
    }
    
    res.json({
      productId: productId,
      title: productData.title,
      tags: productData.tags || 'No tags',
      isMysteryBox: isMysteryBox,
      detectionMethod: detectionMethod,
      tagMatch: hasTagMatch,
      titleMatch: hasTitleMatch,
      cached: true,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Product detection test error:', error);
    res.status(500).json({ 
      error: error.message,
      productId: req.params.productId
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
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Ship Ship Hooray running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
    console.log(`App domain: ${process.env.APP_DOMAIN}`);
    console.log(`Batchy API: ${process.env.BATCHY_API_KEY ? 'Configured' : 'Missing'}`);
    console.log(`Batchy URL: ${process.env.BATCHY_URL || 'https://batchy-production-0e03.up.railway.app'}`);
    startWatchdogs({ port, thresholdCents: appConfig.threshold, feeCents: appConfig.feeUnderThreshold });
  });
}

export default app;
