import crypto from 'crypto';
import request from 'supertest';
import {jest} from '@jest/globals';

const SECRET = 'test-shared-secret';
process.env.BATCHY_API_KEY = SECRET;

const mockFetch = jest.fn(async (url) => {
  if (String(url).includes('/variants/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({variant: {product_id: 123456}}),
    };
  }
  if (String(url).includes('/api/v1/variant-status/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({isPreOrder: false, status: 'IN_STOCK'}),
    };
  }
  throw new Error(`Unexpected network request in test: ${url}`);
});

jest.unstable_mockModule('node-fetch', () => ({default: mockFetch}));

const {
  default: app,
  customerSafeFallbackKind,
  priceForSignedPool,
  verifySignedShippingQuote,
} = await import('../server.js');

/**
 * The signed payload, per contract version.
 *
 * v1 signs the quantity Shopify sends in the callback. v2 signs the cart line's
 * own quantity, published separately as `_ww_ship_qty`, so a delivery-group
 * split that reduces the callback quantity no longer breaks the signature.
 */
function signaturePayload({
  version = '1', quoteId, bucket, poolCents, cartCents, currency = 'USD',
  productId, variantId, signedQuantity = 1, anchor,
}) {
  return [
    version, quoteId, bucket, poolCents, cartCents, currency,
    productId, variantId, signedQuantity, anchor ? '1' : '0',
  ].join('|');
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
    ...(options.version === '2'
      ? {_ww_ship_qty: String(options.signedQuantity)}
      : {}),
    _ww_ship_anchor: options.anchor ? '1' : '0',
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
}) {
  const signatureOptions = {
    version, quoteId, bucket, poolCents, cartCents, currency: 'USD',
    productId: String(productId), variantId: String(variantId),
    signedQuantity, anchor,
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

  test('a split $40 pool charges exactly one $5 fee', async () => {
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
    expect(prices.reduce((sum, price) => sum + price, 0)).toBe(500);
    expect(prices.sort()).toEqual([0, 500]);
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

    expect(readyResponse.body.rates[0]).toMatchObject({service_code: 'RTS_STD', total_price: '500'});
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
    ['quantity raised above the signed quantity', (quotedItem) => { quotedItem.quantity = 2; }],
    ['changed variant', (quotedItem) => { quotedItem.variant_id = 999; }],
  ])('%s invalidates the signature and fails closed at $5', async (_name, tamper) => {
    const quotedItem = item({
      productId: 601, variantId: 601, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
    });
    tamper(quotedItem);
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 4000, `Tamper ${_name}`))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('500');
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
    // billed the punitive $5 on every such cart.
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
    expect(response.body.rates[0].total_price).toBe('500');
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

  test('a stale quote fails customer-safe instead of pricing one warehouse', async () => {
    // The callback cannot know whether another warehouse holds the rest of the
    // pool. The checkout bridge refreshes honest carts; exceptional stale carts
    // ship free rather than recreating a per-warehouse charge.
    const quotedItem = item({
      productId: 703, variantId: 703, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: true,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 3800, 'Stale Under Threshold'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('0');
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
              .toBe(readyTotal >= 5000 ? 0 : 500);
            expect(preorderFees.reduce((sum, fee) => sum + fee, 0))
              .toBe(preorderTotal >= 5000 ? 0 : 500);
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
      poolCents: 4000, hasAnchor: true, hasCompleteAnchor: false,
    }, false)).toBe('split-anchor');
    expect(customerSafeFallbackKind({
      poolCents: 4000, hasAnchor: false, hasCompleteAnchor: false,
    }, false)).toBeNull();
    expect(customerSafeFallbackKind({
      poolCents: 5000, hasAnchor: true, hasCompleteAnchor: true,
    }, false)).toBeNull();
    expect(customerSafeFallbackKind(null, true)).toBeNull();
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

    expect(response.body.rates[0].total_price).toBe('500');
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
    expect(prices.reduce((sum, price) => sum + price, 0)).toBe(500);
    expect(prices.sort()).toEqual([0, 500]);
  });

  test('a callback quantity ABOVE the signed quantity is rejected and fails closed at $5', async () => {
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
    expect(response.body.rates[0].total_price).toBe('500');
  });

  test('a v2 quote with _ww_ship_qty stripped fails closed', async () => {
    const stripped = item({
      version: '2', productId: 807, variantId: 807, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 1, signedQuantity: 2,
    });
    stripped.properties = stripped.properties.filter(({name}) => name !== '_ww_ship_qty');

    const response = await request(app)
      .post('/rates').send(payload([stripped], 4000, 'V2 No Qty')).expect(200);
    expect(response.body.rates[0].total_price).toBe('500');
  });

  test('_ww_ship_qty is signed — inflating it to clear the bound fails closed', async () => {
    const forged = item({
      version: '2', productId: 808, variantId: 808, price: 2000,
      poolCents: 4000, cartCents: 4000, anchor: false,
      quantity: 5, signedQuantity: 1,
    });
    const property = forged.properties.find(({name}) => name === '_ww_ship_qty');
    property.value = '5';

    const response = await request(app)
      .post('/rates').send(payload([forged], 4000, 'V2 Forged Qty')).expect(200);
    expect(response.body.rates[0].total_price).toBe('500');
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
  ])('v2 %s still fails closed at $5', async (_name, tamper) => {
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
    expect(response.body.rates[0].total_price).toBe('500');
  });
});

/**
 * Both contract versions must price correctly at the same time. The storefront
 * and the carrier deploy separately, so during the rollout window some carts in
 * flight are stamped v1 and some v2 — sometimes in the same checkout, if the
 * customer added a line either side of the storefront deploy.
 */
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
    expect(prices.sort()).toEqual([0, 500]);
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
    expect(response.body.rates[0].total_price).toBe('500');
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
