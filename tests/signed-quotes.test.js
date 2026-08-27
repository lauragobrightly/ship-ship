import crypto from 'crypto';
import request from 'supertest';
import {jest} from '@jest/globals';

const SECRET = 'test-shared-secret';
process.env.BATCHY_API_KEY = SECRET;

// Variants Ship Ship's own Batchy lookup classifies as preorder, so a test
// can place a line in a delivery group other than the one Hydrogen stamped.
const PREORDER_VARIANTS = new Set(['9901', '9903', '9905']);

const mockFetch = jest.fn(async (url) => {
  if (String(url).includes('/variants/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({variant: {product_id: 123456}}),
    };
  }
  if (String(url).includes('/api/v1/variant-status/')) {
    const preorder = [...PREORDER_VARIANTS].some((id) => String(url).endsWith(`/${id}`));
    return {
      ok: true,
      status: 200,
      json: async () => (preorder
        ? {isPreOrder: true, status: 'PREORDER_OPEN'}
        : {isPreOrder: false, status: 'IN_STOCK'}),
    };
  }
  throw new Error(`Unexpected network request in test: ${url}`);
});

jest.unstable_mockModule('node-fetch', () => ({default: mockFetch}));

const serverExports = await import('../server.js');
const {
  default: app,
  customerSafeFallbackKind,
  priceForSignedPool,
  probeToken,
  verifySignedShippingQuote,
} = serverExports;

/**
 * The signed payload, per contract version.
 *
 * v1 signs the quantity Shopify sends in the callback. v2 signs the cart line's
 * own quantity, published separately as `_ww_ship_qty`, so a delivery-group
 * split that reduces the callback quantity no longer breaks the signature.
 */
function signaturePayload({
  version = '1', quoteId, bucket, poolCents, cartCents, currency = 'USD',
  productId, variantId, signedQuantity = 1, anchor, guess = false, signedGuess = guess,
}) {
  const payload = [
    version, quoteId, bucket, poolCents, cartCents, currency,
    productId, variantId, signedQuantity, anchor ? '1' : '0',
  ];
  // v3 signs the guess flag last. `signedGuess` lets a test sign one value
  // and stamp another.
  if (version === '3') payload.push(signedGuess ? '1' : '0');
  return payload.join('|');
}

function signedProperties(options, form = 'array') {
  const values = {
    _shipping_bucket: options.bucket,
    _ww_ship_v: options.version ?? '1',
    _ww_ship_quote: options.quoteId,
    _ww_ship_pool: options.bucket,
    _ww_ship_pool_cents: String(options.poolCents),
    _ww_ship_cart_cents: String(options.cartCents),
    _ww_ship_currency: options.currency ?? 'USD',
    ...(options.version === '2' || options.version === '3'
      ? {_ww_ship_qty: String(options.signedQuantity)}
      : {}),
    _ww_ship_anchor: options.anchor ? '1' : '0',
    ...(options.version === '3' ? {_ww_ship_guess: options.guess ? '1' : '0'} : {}),
    _ww_ship_sig: crypto
      .createHmac('sha256', SECRET)
      .update(signaturePayload(options))
      .digest('hex'),
  };
  return form === 'object'
    ? values
    : Object.entries(values).map(([name, value]) => ({name, value}));
}

/**
 * @param quantity       what Shopify sends in THIS delivery group's callback
 * @param signedQuantity the cart line's full quantity at signing time; defaults
 *                       to `quantity`, i.e. an unsplit line
 */
function item({
  productId, variantId, price, bucket = 'ready-stock', poolCents,
  cartCents, quoteId = 'quote-1', anchor = false, quantity = 1,
  signedQuantity = quantity, version = '1', propertiesForm = 'array',
  guess = false, signedGuess = guess,
}) {
  const signatureOptions = {
    version, quoteId, bucket, poolCents, cartCents, currency: 'USD',
    productId: String(productId), variantId: String(variantId),
    signedQuantity, anchor, guess, signedGuess,
  };
  return {
    name: `Item ${variantId}`,
    quantity,
    price,
    product_id: productId,
    variant_id: variantId,
    requires_shipping: true,
    properties: signedProperties(signatureOptions, propertiesForm),
  };
}

function payload(items, cartCents, address = 'Signed Quote Street', discountCents = 0) {
  return {
    rate: {
      origin: {country: 'US', postal_code: '98115'},
      destination: {
        country: 'US', postal_code: '28104', address1: address,
      },
      items,
      currency: 'USD',
      locale: 'en',
      order_totals: {
        subtotal_price: String(cartCents),
        total_price: String(cartCents),
        discount_amount: String(discountCents),
      },
    },
  };
}

describe('signed Hydrogen pool quotes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the reported two-location $76 ready-stock checkout is free in both groups', async () => {
    const firstItem = item({
      productId: 111, variantId: 101, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
    });
    const secondItem = item({
      productId: 222, variantId: 202, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: false,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([firstItem], 7600, 'A')).expect(200),
      request(app).post('/rates').send(payload([secondItem], 7600, 'B')).expect(200),
    ]);

    expect(first.body.rates[0].total_price).toBe('0');
    expect(second.body.rates[0].total_price).toBe('0');
  });

  test('a split $40 pool charges exactly one $6.99 fee', async () => {
    const anchor = item({
      productId: 301, variantId: 301, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true,
    });
    const sibling = item({
      productId: 302, variantId: 302, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([anchor], 4000, 'C')).expect(200),
      request(app).post('/rates').send(payload([sibling], 4000, 'D')).expect(200),
    ]);
    const prices = [first, second].map((response) => Number(response.body.rates[0].total_price));
    expect(prices.reduce((sum, price) => sum + price, 0)).toBe(699);
    expect(prices.sort()).toEqual([0, 699]);
  });

  test('mixed $30 ready-stock and $60 preorder pools qualify independently', async () => {
    const ready = item({
      productId: 401, variantId: 401, price: 3000,
      poolCents: 3000, cartCents: 9000, anchor: true,
    });
    const preorder = item({
      productId: 402, variantId: 402, price: 6000, bucket: 'preorder',
      poolCents: 6000, cartCents: 9000, anchor: true,
    });

    const [readyResponse, preorderResponse] = await Promise.all([
      request(app).post('/rates').send(payload([ready], 9000, 'E')).expect(200),
      request(app).post('/rates').send(payload([preorder], 9000, 'F')).expect(200),
    ]);

    expect(readyResponse.body.rates[0]).toMatchObject({service_code: 'RTS_STD', total_price: '699'});
    expect(preorderResponse.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '0'});
  });

  test('accepts Shopify object-form properties', () => {
    const quotedItem = item({
      productId: 501, variantId: 501, price: 5000,
      poolCents: 5000, cartCents: 5000, anchor: true,
      propertiesForm: 'object',
    });
    const quote = verifySignedShippingQuote(
      [quotedItem], 'ready-stock', payload([quotedItem], 5000).rate, SECRET,
    );
    expect(priceForSignedPool(quote)).toBe(0);
  });

  test.each([
    ['tampered pool total', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_pool_cents');
      property.value = '5000';
    }],
    ['removed anchor', (quotedItem) => {
      quotedItem.properties = quotedItem.properties.filter(({name}) => name !== '_ww_ship_anchor');
    }],
    ['changed variant', (quotedItem) => { quotedItem.variant_id = 999; }],
  ])('%s invalidates the signature and fails customer-safe at $0', async (_name, tamper) => {
    const quotedItem = item({
      productId: 601, variantId: 601, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
    });
    tamper(quotedItem);
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 4000, `Tamper ${_name}`))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a quantity raised above the signed quantity invalidates the signature, and the whole cart is then priced from Shopify', async () => {
    // Shopify lets the customer change quantity inside hosted checkout. The
    // stamp no longer matches, but Shopify's subtotal (4000) equals the raised
    // line (2 × $20): this callback is the entire cart, so there is nothing to
    // double-charge and the fee applies. Before whole-cart certainty this
    // shipped free.
    const quotedItem = item({
      productId: 601, variantId: 601, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
    });
    quotedItem.quantity = 2;
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 4000, 'Tamper quantity raised'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });

  test('stale cart totals fall back to unsigned pricing, not the punitive fee', async () => {
    // Signed at $76, but Shopify reports $75 — the cart changed after
    // stamping. The quote is honest but out of date, so the group is priced
    // as if unstamped: the $75 order subtotal clears the threshold and ships
    // free. (Until 2026-08-13 this charged the punitive $5.)
    const quotedItem = item({
      productId: 701, variantId: 701, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: false,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 7500, 'Stale Cart'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a discounted pool over $50 ships free using its post-discount total', async () => {
    // The production incident of 2026-08-06..13. A 10% code makes Hydrogen
    // sign cartCents 5400 while Shopify's callback reports the pre-discount
    // 6000. Two $30 preorder items — $60 of preorder, "Free over $50" — were
    // billed the punitive $6.99 on every such cart.
    const quotedItem = item({
      productId: 801, variantId: 801, price: 3000, quantity: 2,
      bucket: 'preorder', poolCents: 5400, cartCents: 5400, anchor: true,
      version: '2', signedQuantity: 2,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 6000, 'Discount Code Cart', 600))
      .expect(200);
    const rate = response.body.rates.find((r) => r.service_code === 'PO_STD');
    expect(rate.total_price).toBe('0');
  });

  test('a discounted pool under $50 still carries its single fee', async () => {
    const quotedItem = item({
      productId: 811, variantId: 811, price: 4000,
      poolCents: 3600, cartCents: 3600, anchor: true,
      version: '2', signedQuantity: 1,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 4000, 'Discount Under Threshold', 400))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });

  test('a discounted pool at exactly $50 ships free', async () => {
    const quotedItem = item({
      productId: 813, variantId: 813, price: 6000,
      poolCents: 5000, cartCents: 5000, anchor: true,
      version: '2', signedQuantity: 1,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 6000, 'Discount Exact Threshold', 1000))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('an unstamped line inside a stamped group fails customer-safe instead of punitively', async () => {
    // Express checkout added a line after the async re-stamp: one line signed,
    // its sibling bare. Not tamper evidence — the group fails customer-safe.
    const stampedItem = item({
      productId: 901, variantId: 901, price: 3000,
      bucket: 'preorder', poolCents: 6000, cartCents: 6000, anchor: true,
      version: '2', signedQuantity: 1,
    });
    const bareItem = {
      name: 'Added after stamping',
      quantity: 1,
      price: 3000,
      product_id: 902,
      variant_id: 902,
      requires_shipping: true,
      properties: [{name: '_shipping_bucket', value: 'preorder'}],
    };
    const response = await request(app)
      .post('/rates')
      .send(payload([stampedItem, bareItem], 6000, 'Post-Stamp Addition'))
      .expect(200);
    const rate = response.body.rates.find((r) => r.service_code === 'PO_STD');
    expect(rate.total_price).toBe('0');
  });

  test('a stale quote on a whole cart is priced from Shopify, not shipped free', async () => {
    // Signed as half of a $76 pool, but Shopify now reports a $38 cart and this
    // callback holds all $38 of it. The stamp is out of date; the cart is not
    // ambiguous. There is no other warehouse, so the fee applies. (A stale
    // quote whose callback is only a slice of the cart still ships free — see
    // 'stale cart totals fall back to unsigned pricing'.)
    const quotedItem = item({
      productId: 703, variantId: 703, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 3800, 'Stale Under Threshold'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });

  test('441 threshold × ready/preorder location matrices preserve the exact fee invariant', () => {
    const values = [0, 1, 2499, 4999, 5000, 5001, 12500];
    let cases = 0;

    for (const readyTotal of values) {
      for (const preorderTotal of values) {
        for (let readyLocations = 1; readyLocations <= 3; readyLocations++) {
          for (let preorderLocations = 1; preorderLocations <= 3; preorderLocations++) {
            const readyFees = Array.from({length: readyLocations}, (_, index) =>
              priceForSignedPool({poolCents: readyTotal, hasAnchor: index === 0}));
            const preorderFees = Array.from({length: preorderLocations}, (_, index) =>
              priceForSignedPool({poolCents: preorderTotal, hasAnchor: index === 0}));
            expect(readyFees.reduce((sum, fee) => sum + fee, 0))
              .toBe(readyTotal >= 5000 ? 0 : 699);
            expect(preorderFees.reduce((sum, fee) => sum + fee, 0))
              .toBe(preorderTotal >= 5000 ? 0 : 699);
            cases++;
          }
        }
      }
    }

    expect(cases).toBe(441);
  });
});

describe('customer-safe fallback alerts', () => {
  test('classifies only exceptional free-shipping paths', () => {
    expect(customerSafeFallbackKind(null, false)).toBe('unsigned');
    expect(customerSafeFallbackKind({stale: true}, false)).toBe('stale');
    expect(customerSafeFallbackKind({
      stale: true,
      poolCents: 7600,
      cartCents: 7600,
      effectiveOrderSubtotal: 6840,
    }, false)).toBeNull();
    expect(customerSafeFallbackKind({
      stale: true,
      poolCents: 7600,
      cartCents: 7600,
      effectiveOrderSubtotal: 4940,
    }, false)).toBe('stale');
    expect(customerSafeFallbackKind({
      stale: true,
      poolCents: 6000,
      cartCents: 9000,
      effectiveOrderSubtotal: 8100,
    }, false)).toBe('stale');
    expect(customerSafeFallbackKind({
      poolCents: 4000, hasAnchor: true, hasCompleteAnchor: false,
    }, false)).toBe('split-anchor');
    expect(customerSafeFallbackKind({
      poolCents: 4000, hasAnchor: false, hasCompleteAnchor: false,
    }, false)).toBeNull();
    expect(customerSafeFallbackKind({
      poolCents: 5000, hasAnchor: true, hasCompleteAnchor: true,
    }, false)).toBeNull();
    expect(customerSafeFallbackKind(null, true)).toBe('invalid');
  });

  test('a fallback on a group that clears $50 by itself is silent — no fee was waived', () => {
    // 2026-08-27: Shop-app and draft-order carts at $140/$220 alerted all
    // morning although $0 was the correct price for a $50+ bucket.
    expect(customerSafeFallbackKind(null, false, 5000, 22000)).toBeNull();
    expect(customerSafeFallbackKind({stale: true, reason: 'x'}, false, 5000, 7400)).toBeNull();
    // Under $50 a fee really was waived: still alerts.
    expect(customerSafeFallbackKind(null, false, 5000, 3800)).toBe('unsigned');
    expect(customerSafeFallbackKind({stale: true, reason: 'x'}, false, 5000, 3800)).toBe('stale');
    // Exactly $50 qualifies, matching the pricing rule.
    expect(customerSafeFallbackKind(null, false, 5000, 5000)).toBeNull();
    // Tamper-shaped rejections are never silenced by size.
    expect(customerSafeFallbackKind(null, true, 5000, 22000)).toBe('invalid');
    // No group subtotal supplied: previous behaviour.
    expect(customerSafeFallbackKind(null, false)).toBe('unsigned');
  });

  test('a discount typed into hosted checkout is not staleness', () => {
    // Hydrogen stamped the pre-discount total (7600). The customer then
    // entered a 10% code in hosted checkout, so Shopify reports 7600 pre and
    // 6840 post. The cart itself never changed, so the quote must stand.
    const quotedItem = item({
      version: '2', productId: 990, variantId: 990, price: 3800, quantity: 2,
      poolCents: 7600, cartCents: 7600, anchor: true, signedQuantity: 2,
    });
    const quote = verifySignedShippingQuote(
      [quotedItem],
      'ready-stock',
      payload([quotedItem], 7600, 'Post-stamp discount', 760).rate,
      SECRET,
    );
    expect(quote.stale).toBeUndefined();
    expect(quote).toMatchObject({
      quoteId: 'quote-1',
      poolCents: 7600,
      cartCents: 7600,
      effectiveOrderSubtotal: 6840,
      effectivePoolCents: 6840,
    });
    // Still over $50 after the discount, so free is correct and silent.
    expect(priceForSignedPool(quote)).toBe(0);
    expect(customerSafeFallbackKind(quote, false)).toBeNull();
  });

  test('a genuine post-stamp cart change is still stale and keeps its totals', () => {
    // Signed at 7600; Shopify now reports a 5000 cart with no discount. That
    // matches neither the pre- nor the post-discount figure: the cart changed.
    const quotedItem = item({
      version: '2', productId: 991, variantId: 991, price: 3800, quantity: 2,
      poolCents: 7600, cartCents: 7600, anchor: true, signedQuantity: 2,
    });
    const quote = verifySignedShippingQuote(
      [quotedItem],
      'ready-stock',
      payload([quotedItem], 5000, 'Line removed after stamping', 0).rate,
      SECRET,
    );
    expect(quote).toMatchObject({
      stale: true,
      quoteId: 'quote-1',
      poolCents: 7600,
      cartCents: 7600,
      effectiveOrderSubtotal: 5000,
    });
    expect(priceForSignedPool(quote)).toBe(0);
  });
});

/**
 * Regression cover for the 2026-08-19 incident: orders #36872 and #36879, a
 * single $30 Smaug Lovey with WILDINSIDERS (10% off), shipped free. Commit
 * b70e7f2 made a stale quote ship free, and comparing the signed pre-discount
 * total against Shopify's post-discount subtotal marked every discounted
 * checkout stale — so any under-$50 cart with a code shipped for $0.
 */
describe('discount codes do not waive the under-$50 fee', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the exact incident: $30 cart + 10% code still pays $6.99', async () => {
    const smaug = item({
      version: '2', productId: 8797164667032, variantId: 46875982954648,
      price: 3000, quantity: 1, signedQuantity: 1,
      poolCents: 3000, cartCents: 3000, anchor: true,
    });
    const res = await request(app)
      .post('/rates')
      .send(payload([smaug], 3000, 'Incident 36872', 300))
      .expect(200);
    expect(res.body.rates).toHaveLength(1);
    expect(res.body.rates[0].total_price).toBe('699');
  });

  test('the same cart with no discount code is unchanged at $6.99', async () => {
    const smaug = item({
      version: '2', productId: 8797164667032, variantId: 46875982954648,
      price: 3000, quantity: 1, signedQuantity: 1,
      poolCents: 3000, cartCents: 3000, anchor: true,
    });
    const res = await request(app)
      .post('/rates')
      .send(payload([smaug], 3000, 'Control 36870', 0))
      .expect(200);
    expect(res.body.rates[0].total_price).toBe('699');
  });

  test('a discount that drops a single-pool cart under $50 starts charging', () => {
    // $56 signed, 30% off -> $39.20 actually paid. The customer is under the
    // threshold on the money that changed hands, so the fee applies.
    const line = item({
      version: '2', productId: 555, variantId: 555, price: 5600, quantity: 1,
      signedQuantity: 1, poolCents: 5600, cartCents: 5600, anchor: true,
    });
    const quote = verifySignedShippingQuote(
      [line], 'ready-stock',
      payload([line], 5600, 'Threshold crossing', 1680).rate,
      SECRET,
    );
    expect(quote.stale).toBeUndefined();
    expect(quote.effectivePoolCents).toBe(3920);
    expect(priceForSignedPool(quote)).toBe(699);
  });

  test('a discount already in the Hydrogen cart at stamping time still verifies', () => {
    // Here Hydrogen saw the discount, so the signed total is already the
    // post-discount figure. It must match the post-discount side instead.
    const line = item({
      version: '2', productId: 556, variantId: 556, price: 6840, quantity: 1,
      signedQuantity: 1, poolCents: 6840, cartCents: 6840, anchor: true,
    });
    const quote = verifySignedShippingQuote(
      [line], 'ready-stock',
      payload([line], 7600, 'Pre-stamp discount', 760).rate,
      SECRET,
    );
    expect(quote.stale).toBeUndefined();
    expect(quote.effectivePoolCents).toBe(6840);
    expect(priceForSignedPool(quote)).toBe(0);
  });

  test('a mixed cart allocates the discount pro-rata across pools', () => {
    // Pool is $30 of an $80 cart with 10% off. The pool's share of the $8
    // discount is $3, so it is worth $27 — still under $50, still pays.
    const line = item({
      version: '2', productId: 557, variantId: 557, price: 3000, quantity: 1,
      signedQuantity: 1, poolCents: 3000, cartCents: 8000, anchor: true,
    });
    const quote = verifySignedShippingQuote(
      [line], 'ready-stock',
      payload([line], 8000, 'Mixed cart', 800).rate,
      SECRET,
    );
    expect(quote.stale).toBeUndefined();
    expect(quote.effectivePoolCents).toBe(2700);
    expect(priceForSignedPool(quote)).toBe(699);
  });

  test('mixed $60 + $60 at 20% off charges both pools instead of shipping both free', () => {
    // The gap left open by the single-pool-only allocation: each pool is $60
    // pre-discount but $48 paid, so each owes the fee. Previously both free.
    const rts = item({
      version: '2', productId: 601, variantId: 601, price: 6000, quantity: 1,
      signedQuantity: 1, bucket: 'ready-stock', poolCents: 6000, cartCents: 12000, anchor: true,
    });
    const po = item({
      version: '2', productId: 602, variantId: 602, price: 6000, quantity: 1,
      signedQuantity: 1, bucket: 'preorder', poolCents: 6000, cartCents: 12000, anchor: true,
    });
    const rtsQuote = verifySignedShippingQuote([rts], 'ready-stock', payload([rts], 12000, 'Mixed 60/60 RTS', 2400).rate, SECRET);
    const poQuote = verifySignedShippingQuote([po], 'preorder', payload([po], 12000, 'Mixed 60/60 PO', 2400).rate, SECRET);
    expect(rtsQuote.effectivePoolCents).toBe(4800);
    expect(poQuote.effectivePoolCents).toBe(4800);
    expect(priceForSignedPool(rtsQuote)).toBe(699);
    expect(priceForSignedPool(poQuote)).toBe(699);
  });

  test('mixed cart where only one pool crosses the threshold charges only that pool', () => {
    // $60 RTS + $40 PO = $100, 10% off. RTS -> $54 (free), PO -> $36 (pays).
    const rts = item({
      version: '2', productId: 603, variantId: 603, price: 6000, quantity: 1,
      signedQuantity: 1, bucket: 'ready-stock', poolCents: 6000, cartCents: 10000, anchor: true,
    });
    const po = item({
      version: '2', productId: 604, variantId: 604, price: 4000, quantity: 1,
      signedQuantity: 1, bucket: 'preorder', poolCents: 4000, cartCents: 10000, anchor: true,
    });
    const rtsQuote = verifySignedShippingQuote([rts], 'ready-stock', payload([rts], 10000, 'Mixed 60/40 RTS', 1000).rate, SECRET);
    const poQuote = verifySignedShippingQuote([po], 'preorder', payload([po], 10000, 'Mixed 60/40 PO', 1000).rate, SECRET);
    expect(rtsQuote.effectivePoolCents).toBe(5400);
    expect(poQuote.effectivePoolCents).toBe(3600);
    expect(priceForSignedPool(rtsQuote)).toBe(0);
    expect(priceForSignedPool(poQuote)).toBe(699);
  });

  test('a discount already in the cart at stamping is not double-counted in a mixed cart', () => {
    // Signed values are post-discount already ($27 pool of a $72 cart). The
    // allocation must not subtract the discount a second time.
    const line = item({
      version: '2', productId: 605, variantId: 605, price: 2700, quantity: 1,
      signedQuantity: 1, poolCents: 2700, cartCents: 7200, anchor: true,
    });
    const quote = verifySignedShippingQuote(
      [line], 'ready-stock',
      payload([line], 8000, 'Pre-stamped mixed', 800).rate,
      SECRET,
    );
    expect(quote.stale).toBeUndefined();
    expect(quote.effectivePoolCents).toBe(2700);
    expect(priceForSignedPool(quote)).toBe(699);
  });
});

/**
 * v2 signs `_ww_ship_qty` — the cart line's own quantity — instead of the
 * quantity Shopify happens to send in a delivery-group callback.
 *
 * The live defect: a single cart line of quantity 2 fulfilled from two
 * locations produces two callbacks of quantity 1. Under v1 the signature was
 * computed over quantity 2, so neither callback verified, and a $76 pool that
 * had earned free shipping was billed the punitive flat $5.
 */
describe('v2 quotes tolerate delivery-group quantity splits', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the reported defect: a $76 line of qty 2 split across two locations ships free', async () => {
    const half = () => item({
      version: '2', productId: 801, variantId: 801, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
      quantity: 1, signedQuantity: 2,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([half()], 7600, 'Split A')).expect(200),
      request(app).post('/rates').send(payload([half()], 7600, 'Split B')).expect(200),
    ]);

    expect(first.body.rates[0].total_price).toBe('0');
    expect(second.body.rates[0].total_price).toBe('0');
  });

  test('an under-threshold anchor line split by warehouses cannot charge twice', async () => {
    const half = () => item({
      version: '2', productId: 812, variantId: 812, price: 1000,
      poolCents: 4000, cartCents: 4000, anchor: true,
      quantity: 2, signedQuantity: 4,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([half()], 4000, 'Under Split A')).expect(200),
      request(app).post('/rates').send(payload([half()], 4000, 'Under Split B')).expect(200),
    ]);

    expect([first.body.rates[0].total_price, second.body.rates[0].total_price])
      .toEqual(['0', '0']);
  });

  test('the same split under v1 is exactly the bug — proving the version bump is the fix', async () => {
    const v1Half = item({
      version: '1', productId: 802, variantId: 802, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
      quantity: 1, signedQuantity: 2,
    });
    const response = await request(app)
      .post('/rates').send(payload([v1Half], 7600, 'Split v1')).expect(200);

    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a split preorder line behaves identically', async () => {
    const half = () => item({
      version: '2', bucket: 'preorder', productId: 803, variantId: 803, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
      quantity: 1, signedQuantity: 2,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([half()], 7600, 'PO Split A')).expect(200),
      request(app).post('/rates').send(payload([half()], 7600, 'PO Split B')).expect(200),
    ]);

    expect(first.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '0'});
    expect(second.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '0'});
  });

  test('an unsplit v2 line still verifies and an under-$50 pool still pays once', async () => {
    const anchor = item({
      version: '2', productId: 804, variantId: 804, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true, quantity: 1,
    });
    const sibling = item({
      version: '2', productId: 805, variantId: 805, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false, quantity: 1,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([anchor], 4000, 'V2 Under A')).expect(200),
      request(app).post('/rates').send(payload([sibling], 4000, 'V2 Under B')).expect(200),
    ]);
    const prices = [first, second].map((response) => Number(response.body.rates[0].total_price));
    expect(prices.reduce((sum, price) => sum + price, 0)).toBe(699);
    expect(prices.sort()).toEqual([0, 699]);
  });

  test('a callback quantity ABOVE the signed quantity is rejected and fails customer-safe', async () => {
    // A split can only ever shrink a group's quantity. Growth is the inflation
    // the bound exists to catch: 3 units billed against a 1-unit signature.
    const inflated = item({
      version: '2', productId: 806, variantId: 806, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 1, signedQuantity: 1,
    });
    inflated.quantity = 3;

    const response = await request(app)
      .post('/rates').send(payload([inflated], 4000, 'V2 Inflated')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a v2 quote with _ww_ship_qty stripped fails customer-safe', async () => {
    const stripped = item({
      version: '2', productId: 807, variantId: 807, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 1, signedQuantity: 2,
    });
    stripped.properties = stripped.properties.filter(({name}) => name !== '_ww_ship_qty');

    const response = await request(app)
      .post('/rates').send(payload([stripped], 4000, 'V2 No Qty')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('_ww_ship_qty is signed — inflating it to clear the bound fails customer-safe', async () => {
    const forged = item({
      version: '2', productId: 808, variantId: 808, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 5, signedQuantity: 1,
    });
    const property = forged.properties.find(({name}) => name === '_ww_ship_qty');
    property.value = '5';

    const response = await request(app)
      .post('/rates').send(payload([forged], 4000, 'V2 Forged Qty')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test.each([
    ['tampered pool total', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_pool_cents');
      property.value = '9900';
    }],
    ['tampered cart total', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_cart_cents');
      property.value = '9900';
    }],
    ['tampered bucket', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_pool');
      property.value = 'preorder';
    }],
    ['tampered currency', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_currency');
      property.value = 'CAD';
    }],
    ['flipped anchor', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_anchor');
      property.value = '1';
    }],
    ['changed variant', (quotedItem) => { quotedItem.variant_id = 999; }],
    ['unknown version', (quotedItem) => {
      const property = quotedItem.properties.find(({name}) => name === '_ww_ship_v');
      property.value = '3';
    }],
  ])('v2 %s fails customer-safe at $0', async (_name, tamper) => {
    const quotedItem = item({
      version: '2', productId: 809, variantId: 809, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 1, signedQuantity: 2,
    });
    tamper(quotedItem);
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 4000, `V2 Tamper ${_name}`))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });
});

/**
 * Both contract versions must price correctly at the same time. The storefront
 * and the carrier deploy separately, so during the rollout window some carts in
 * flight are stamped v1 and some v2 — sometimes in the same checkout, if the
 * customer added a line either side of the storefront deploy.
 */
describe('v3 quotes tolerate delivery-group quantity splits exactly like v2', () => {
  beforeEach(() => jest.clearAllMocks());

  const v3 = (options) => item({version: '3', signedQuantity: options.quantity ?? 1, ...options});

  test('the 2026-08-26 defect: a complete anchor plus a split sibling under $50 still pays its fee', async () => {
    // Hydrogen signed a $40 preorder pool: a $20 anchor (qty 1) and a $10
    // line of qty 2. Shopify split the qty-2 line, so this group's callback
    // carries qty 1 of it. The v3 signature was computed over the line's own
    // quantity (2). A build that rebuilds v3 payloads from the callback
    // quantity fails the sibling's HMAC, rejects the group, and ships free.
    const anchor = v3({
      bucket: 'preorder', productId: 9101, variantId: 9901, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true, quantity: 1,
    });
    const splitSibling = v3({
      bucket: 'preorder', productId: 9103, variantId: 9903, price: 1000,
      poolCents: 4000, cartCents: 4000, anchor: false, quantity: 1, signedQuantity: 2,
    });

    const response = await request(app)
      .post('/rates').send(payload([anchor, splitSibling], 4000, 'V3 Anchor Plus Split')).expect(200);
    expect(response.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '699'});
  });

  test('the same shape under v2 prices identically, so the two contracts agree', async () => {
    const anchor = item({
      version: '2', bucket: 'preorder', productId: 9101, variantId: 9901, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true, quantity: 1,
    });
    const splitSibling = item({
      version: '2', bucket: 'preorder', productId: 9103, variantId: 9903, price: 1000,
      poolCents: 4000, cartCents: 4000, anchor: false, quantity: 1, signedQuantity: 2,
    });

    const response = await request(app)
      .post('/rates').send(payload([anchor, splitSibling], 4000, 'V2 Anchor Plus Split')).expect(200);
    expect(response.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '699'});
  });

  test('a $76 v3 line of qty 2 split across two locations ships free in both groups', async () => {
    const half = () => v3({
      productId: 9201, variantId: 9202, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
      quantity: 1, signedQuantity: 2,
    });

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([half()], 7600, 'V3 Split A')).expect(200),
      request(app).post('/rates').send(payload([half()], 7600, 'V3 Split B')).expect(200),
    ]);
    expect(first.body.rates[0].total_price).toBe('0');
    expect(second.body.rates[0].total_price).toBe('0');
  });

  test('a v3 callback quantity above the signed quantity is still rejected', async () => {
    const inflated = v3({
      productId: 9301, variantId: 9302, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false, quantity: 1,
    });
    inflated.quantity = 3;

    const response = await request(app)
      .post('/rates').send(payload([inflated], 4000, 'V3 Inflated')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a v3 quote with _ww_ship_qty stripped fails customer-safe', async () => {
    const stripped = v3({
      productId: 9401, variantId: 9402, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false, quantity: 1, signedQuantity: 2,
    });
    stripped.properties = stripped.properties.filter(({name}) => name !== '_ww_ship_qty');

    const response = await request(app)
      .post('/rates').send(payload([stripped], 4000, 'V3 No Qty')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });
});

describe('probe traffic must identify itself exactly', () => {
  const cart = () => [item({
    version: '3', bucket: 'preorder', productId: 9501, variantId: 9901, price: 3000,
    poolCents: 3000, cartCents: 3000, anchor: true, quantity: 1,
  })];

  test('the derived token is accepted and the cart prices normally', async () => {
    const response = await request(app)
      .post('/rates')
      .set('X-Ship-Ship-Probe', probeToken())
      .send(payload(cart(), 3000, 'Probe OK'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });

  test.each([
    ['the retired magic string', 'matrix'],
    ['a near miss', 'v3'],
    ['an empty value', ''],
  ])('%s is refused with a 400 instead of pricing as live traffic', async (_label, value) => {
    const response = await request(app)
      .post('/rates')
      .set('X-Ship-Ship-Probe', value)
      .send(payload(cart(), 3000, 'Probe Bad'))
      .expect(400);
    expect(response.body.error).toMatch(/probe token/);
  });

  test('no header at all is a live callback', async () => {
    const response = await request(app)
      .post('/rates').send(payload(cart(), 3000, 'Not A Probe')).expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });
});

describe('v1 and v2 coexist during the rollout window', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a v1 cart signed before the storefront deploy still ships free at $76', async () => {
    const legacy = item({
      version: '1', productId: 901, variantId: 901, price: 7600,
      poolCents: 7600, cartCents: 7600, anchor: true, quantity: 1,
    });
    const response = await request(app)
      .post('/rates').send(payload([legacy], 7600, 'Legacy v1')).expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
  });

  test('a v1 cart under $50 still pays exactly one fee', async () => {
    const anchor = item({
      version: '1', productId: 902, variantId: 902, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true,
    });
    const sibling = item({
      version: '1', productId: 903, variantId: 903, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
    });
    const [first, second] = await Promise.all([
      request(app).post('/rates').send(payload([anchor], 4000, 'Legacy Under A')).expect(200),
      request(app).post('/rates').send(payload([sibling], 4000, 'Legacy Under B')).expect(200),
    ]);
    const prices = [first, second].map((response) => Number(response.body.rates[0].total_price));
    expect(prices.sort()).toEqual([0, 699]);
  });

  test('v1 and v2 lines in the same delivery group agree on one pool and price once', async () => {
    // Same quoteId, same pool: a mixed-version group is only coherent if both
    // signatures verify against their own contract and then agree on the pool.
    const v1Line = item({
      version: '1', productId: 904, variantId: 904, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: true, quantity: 1,
    });
    const v2Line = item({
      version: '2', productId: 905, variantId: 905, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 1, signedQuantity: 2,
    });

    const response = await request(app)
      .post('/rates').send(payload([v1Line, v2Line], 4000, 'Mixed Versions')).expect(200);
    expect(response.body.rates[0].total_price).toBe('699');
  });

  test('a v2 quote verifies with the same helper the v1 path uses', () => {
    const quotedItem = item({
      version: '2', productId: 906, variantId: 906, price: 5000,
      poolCents: 5000, cartCents: 5000, anchor: true,
      quantity: 1, signedQuantity: 2, propertiesForm: 'object',
    });
    const quote = verifySignedShippingQuote(
      [quotedItem], 'ready-stock', payload([quotedItem], 5000).rate, SECRET,
    );
    expect(quote).toMatchObject({poolCents: 5000, hasAnchor: true});
    expect(priceForSignedPool(quote)).toBe(0);
  });
});

/**
 * v3 stamps `_ww_ship_guess`. Hydrogen sets it to '1' when Batchy never
 * answered for a line (even after one retry): the line's cents stayed out of
 * the pool total and it was never anchored. This service reclassifies every
 * line itself, so a guessed line that lands in the "other" group is simply
 * priced with that group — not rejected, and not zeroed. (The 2026-08-25
 * 22:24Z incident: one stale ready-stock stamp on a variant Batchy had moved
 * to preorder made a $76 group ship free.)
 */
describe('v3 quotes let the carrier reclassify a guessed line', () => {
  beforeEach(() => jest.clearAllMocks());

  const v3 = (options) => item({version: '3', signedQuantity: options.quantity ?? 1, ...options});

  test('a guessed ready-stock line that Batchy says is preorder joins the preorder group and it still pays under $50', async () => {
    // Hydrogen: $40 preorder pool (firm) + a $30 line it guessed ready-stock,
    // cents excluded from both pools. Ship Ship's lookup puts 9901 in preorder.
    const firm = v3({
      productId: 9900, variantId: 9900, price: 4000, bucket: 'preorder',
      poolCents: 4000, cartCents: 7000, anchor: true,
    });
    const guessed = v3({
      productId: 9901, variantId: 9901, price: 3000, bucket: 'ready-stock',
      poolCents: 0, cartCents: 7000, anchor: false, guess: true,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([firm, guessed], 7000, 'Guess reclassified under'))
      .expect(200);
    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '699'});
  });

  test('the same shape with a $60 firm pool ships free', async () => {
    const firm = v3({
      productId: 9902, variantId: 9902, price: 6000, bucket: 'preorder',
      poolCents: 6000, cartCents: 9000, anchor: true,
    });
    const guessed = v3({
      productId: 9903, variantId: 9903, price: 3000, bucket: 'ready-stock',
      poolCents: 0, cartCents: 9000, anchor: false, guess: true,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([firm, guessed], 9000, 'Guess reclassified over'))
      .expect(200);
    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '0'});
  });

  test('a guessed line that stays in its stamped group is ignored for pool consensus', () => {
    const firm = v3({
      productId: 9910, variantId: 9910, price: 3000,
      poolCents: 3000, cartCents: 5500, anchor: true,
    });
    const guessed = v3({
      productId: 9911, variantId: 9911, price: 2500,
      poolCents: 3000, cartCents: 5500, anchor: false, guess: true,
    });
    const quote = verifySignedShippingQuote(
      [firm, guessed], 'ready-stock', payload([firm, guessed], 5500).rate, SECRET,
    );
    expect(quote).toMatchObject({poolCents: 3000, hasAnchor: true});
    expect(priceForSignedPool(quote)).toBe(699);
  });

  test('a group made only of guessed lines is stale; a whole cart is then priced, a slice ships free', async () => {
    const guessed = v3({
      productId: 9905, variantId: 9905, price: 3000, bucket: 'ready-stock',
      poolCents: 0, cartCents: 3000, anchor: false, guess: true,
    });
    const quote = verifySignedShippingQuote([guessed], 'preorder', payload([guessed], 3000).rate, SECRET);
    expect(quote).toMatchObject({stale: true});
    // Shopify says the cart is $30 and this callback holds all $30: whole cart.
    const whole = await request(app)
      .post('/rates')
      .send(payload([guessed], 3000, 'All guessed, whole cart'))
      .expect(200);
    expect(whole.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '699'});
    // Shopify says the cart is $55: another group exists somewhere. Not
    // punitive, not per-warehouse — customer-safe $0.
    const slice = await request(app)
      .post('/rates')
      .send(payload([guessed], 5500, 'All guessed, slice'))
      .expect(200);
    expect(slice.body.rates[0]).toMatchObject({service_code: 'PO_STD', total_price: '0'});
  });

  test('an anchor on a guessed line is rejected', () => {
    const guessed = v3({
      productId: 9920, variantId: 9920, price: 3000,
      poolCents: 3000, cartCents: 3000, anchor: true, guess: true,
    });
    expect(verifySignedShippingQuote([guessed], 'ready-stock', payload([guessed], 3000).rate, SECRET)).toBeNull();
  });

  test('a flipped guess flag is an HMAC mismatch', () => {
    const firm = v3({
      productId: 9930, variantId: 9930, price: 3000,
      poolCents: 3000, cartCents: 3000, anchor: false, guess: true, signedGuess: false,
    });
    expect(verifySignedShippingQuote([firm], 'ready-stock', payload([firm], 3000).rate, SECRET)).toBeNull();
    const other = v3({
      productId: 9931, variantId: 9931, price: 3000,
      poolCents: 3000, cartCents: 3000, anchor: false, guess: false, signedGuess: true,
    });
    expect(verifySignedShippingQuote([other], 'ready-stock', payload([other], 3000).rate, SECRET)).toBeNull();
  });

  test('a malformed guess flag is rejected', () => {
    const line = v3({
      productId: 9940, variantId: 9940, price: 3000,
      poolCents: 3000, cartCents: 3000, anchor: true,
    });
    line.properties.find(({name}) => name === '_ww_ship_guess').value = 'maybe';
    expect(verifySignedShippingQuote([line], 'ready-stock', payload([line], 3000).rate, SECRET)).toBeNull();
  });

  test('a v3 non-guessed line in the wrong group is still rejected', () => {
    const firm = v3({
      productId: 9950, variantId: 9950, price: 3000, bucket: 'ready-stock',
      poolCents: 3000, cartCents: 3000, anchor: true, guess: false,
    });
    expect(verifySignedShippingQuote([firm], 'preorder', payload([firm], 3000).rate, SECRET)).toBeNull();
  });

  test('a firm v3 line verifies and prices exactly like v2', () => {
    const firm = v3({
      productId: 9960, variantId: 9960, price: 7600, quantity: 2,
      poolCents: 7600, cartCents: 7600, anchor: true,
    });
    const quote = verifySignedShippingQuote([firm], 'ready-stock', payload([firm], 7600).rate, SECRET);
    expect(quote).toMatchObject({poolCents: 7600, hasAnchor: true, hasCompleteAnchor: true});
    expect(priceForSignedPool(quote)).toBe(0);
  });

  test('v2 quotes are unchanged: no guess flag in the payload, mismatch still rejects', () => {
    const v2 = item({
      version: '2', productId: 9970, variantId: 9970, price: 4000, quantity: 1,
      signedQuantity: 1, poolCents: 4000, cartCents: 4000, anchor: true,
    });
    expect(v2.properties.some(({name}) => name === '_ww_ship_guess')).toBe(false);
    const quote = verifySignedShippingQuote([v2], 'ready-stock', payload([v2], 4000).rate, SECRET);
    expect(priceForSignedPool(quote)).toBe(699);
    expect(verifySignedShippingQuote([v2], 'preorder', payload([v2], 4000).rate, SECRET)).toBeNull();
  });
});

describe('whole-cart certainty from Shopify order totals', () => {
  beforeEach(() => jest.clearAllMocks());

  const {wholeCartCertainty, priceWholeCartBucket} = serverExports;

  // A line with no stamp at all: the PDP Shop Pay button (a cart permalink),
  // the Shop app, a draft order. Variants 9901/9903/9905 classify as preorder.
  function unsigned({productId, variantId, price, quantity = 1}) {
    return {
      name: `Item ${variantId}`, quantity, price,
      product_id: productId, variant_id: variantId,
      requires_shipping: true, properties: null,
    };
  }
  async function priced(items, cartCents, address, discountCents = 0) {
    const response = await request(app)
      .post('/rates')
      .send(payload(items, cartCents, address, discountCents))
      .expect(200);
    return Object.fromEntries(response.body.rates.map((r) => [r.service_code, Number(r.total_price)]));
  }

  test('order #37269: an unsigned $38 PDP Shop Pay checkout pays the fee', async () => {
    // 2026-08-27 15:05 PT. landing_site=/cart/48385345650840:1?payment=shop_pay,
    // no line properties, one $38 romper, Shopify subtotal 3800. It shipped
    // free. This callback is the whole cart; nothing can double the fee.
    expect(await priced([unsigned({productId: 1101, variantId: 1101, price: 3800})], 3800, 'Whole 38'))
      .toEqual({RTS_STD: 699});
  });

  test('an unsigned whole cart at or over $50 ships free', async () => {
    expect(await priced([unsigned({productId: 1102, variantId: 1102, price: 3800, quantity: 2})], 7600, 'Whole 76'))
      .toEqual({RTS_STD: 0});
    expect(await priced([unsigned({productId: 1103, variantId: 1103, price: 5000})], 5000, 'Whole 50'))
      .toEqual({RTS_STD: 0});
  });

  test('several unsigned lines that together are the whole cart price as one pool', async () => {
    const two = [
      unsigned({productId: 1104, variantId: 1104, price: 2000}),
      unsigned({productId: 1105, variantId: 1105, price: 2000}),
    ];
    expect(await priced(two, 4000, 'Whole 20+20')).toEqual({RTS_STD: 699});
    const bigger = [
      unsigned({productId: 1106, variantId: 1106, price: 3800}),
      unsigned({productId: 1107, variantId: 1107, price: 3800}),
    ];
    expect(await priced(bigger, 7600, 'Whole 38+38')).toEqual({RTS_STD: 0});
  });

  test('an unsigned $38 slice of a $76 cart stays customer-safe at $0', async () => {
    // The other $38 may be a second ready-stock warehouse. Charging here could
    // charge the pool twice, so this stays on the fallback path and alerts.
    expect(await priced([unsigned({productId: 1108, variantId: 1108, price: 3800})], 7600, 'Slice 38 of 76'))
      .toEqual({RTS_STD: 0});
  });

  test('a whole cart is priced on its post-discount value', async () => {
    // $38 less a 10% code: $34.20, still under $50, still the fee.
    expect(await priced([unsigned({productId: 1109, variantId: 1109, price: 3800})], 3800, 'Whole 38 -10%', 380))
      .toEqual({RTS_STD: 699});
    // $76 less 10%: $68.40, still free.
    expect(await priced([unsigned({productId: 1110, variantId: 1110, price: 3800, quantity: 2})], 7600, 'Whole 76 -10%', 760))
      .toEqual({RTS_STD: 0});
    // $60 of preorder less 20%: $48 crosses under the threshold — the fee, as
    // the signed path would also decide.
    expect(await priced([unsigned({productId: 1111, variantId: 9901, price: 3000, quantity: 2})], 6000, 'Whole PO 60 -20%', 1200))
      .toEqual({PO_STD: 699});
  });

  test('a tamper-shaped stamp on a whole cart is priced from Shopify, not from the stamp', async () => {
    const quotedItem = item({
      productId: 1112, variantId: 1112, price: 3800,
      poolCents: 3800, cartCents: 3800, anchor: true,
    });
    quotedItem.properties.find(({name}) => name === '_ww_ship_pool_cents').value = '9900';
    expect(await priced([quotedItem], 3800, 'Tampered whole cart')).toEqual({RTS_STD: 699});
  });

  test('a verified signed quote still outranks certainty', async () => {
    // Coherent, valid stamp that says the fee anchor lives in another group.
    // Hydrogen never emits this for a one-line cart, but the contract is that a
    // verified quote is authoritative; certainty only replaces the $0 fallbacks.
    const quotedItem = item({
      productId: 1113, variantId: 1113, price: 3800,
      poolCents: 3800, cartCents: 3800, anchor: false,
    });
    expect(await priced([quotedItem], 3800, 'Verified anchor elsewhere')).toEqual({RTS_STD: 0});
  });

  test('a callback holding both buckets is never whole-cart priced', async () => {
    // Physically impossible (the pools are different locations); it means the
    // storefront and Batchy disagree about a variant. Stay customer-safe.
    const mixed = [
      unsigned({productId: 1114, variantId: 1114, price: 3800}),
      unsigned({productId: 1115, variantId: 9903, price: 3000}),
    ];
    expect(await priced(mixed, 6800, 'Mixed buckets whole cart')).toEqual({RTS_STD: 0, PO_STD: 0});
  });

  test('wholeCartCertainty is exact and refuses anything it cannot prove', () => {
    const rate = (order_totals) => ({order_totals});
    expect(wholeCartCertainty(rate({subtotal_price: '3800'}), 3800))
      .toEqual({orderSubtotal: 3800, orderDiscount: 0, effectiveCents: 3800});
    expect(wholeCartCertainty(rate({subtotal_price: '3800', discount_amount: '380'}), 3800))
      .toEqual({orderSubtotal: 3800, orderDiscount: 380, effectiveCents: 3420});
    expect(wholeCartCertainty(rate({subtotal_price: '7600'}), 3800)).toBeNull();      // a slice
    expect(wholeCartCertainty(rate({subtotal_price: '3800'}), 3801)).toBeNull();      // off by a cent
    expect(wholeCartCertainty(rate(undefined), 3800)).toBeNull();                      // no totals at all
    expect(wholeCartCertainty(rate({subtotal_price: '38.00'}), 3800)).toBeNull();     // malformed
    expect(wholeCartCertainty(rate({subtotal_price: '3800', discount_amount: 'x'}), 3800)).toBeNull();
    expect(wholeCartCertainty(rate({subtotal_price: '0'}), 0)).toBeNull();
    expect(priceWholeCartBucket({effectiveCents: 4999}, 5000)).toBe(699);
    expect(priceWholeCartBucket({effectiveCents: 5000}, 5000)).toBe(0);
  });
});
