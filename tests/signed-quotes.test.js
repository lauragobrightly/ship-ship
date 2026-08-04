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
  priceForSignedPool,
  verifySignedShippingQuote,
} = await import('../server.js');

function signaturePayload({
  quoteId, bucket, poolCents, cartCents, currency = 'USD',
  productId, variantId, quantity = 1, anchor,
}) {
  return [
    '1', quoteId, bucket, poolCents, cartCents, currency,
    productId, variantId, quantity, anchor ? '1' : '0',
  ].join('|');
}

function signedProperties(options, form = 'array') {
  const values = {
    _shipping_bucket: options.bucket,
    _ww_ship_v: '1',
    _ww_ship_quote: options.quoteId,
    _ww_ship_pool: options.bucket,
    _ww_ship_pool_cents: String(options.poolCents),
    _ww_ship_cart_cents: String(options.cartCents),
    _ww_ship_currency: options.currency ?? 'USD',
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

function item({
  productId, variantId, price, bucket = 'ready-stock', poolCents,
  cartCents, quoteId = 'quote-1', anchor = false, quantity = 1,
  propertiesForm = 'array',
}) {
  const signatureOptions = {
    quoteId, bucket, poolCents, cartCents, currency: 'USD',
    productId: String(productId), variantId: String(variantId), quantity, anchor,
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

function payload(items, cartCents, address = 'Signed Quote Street') {
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
        discount_amount: '0',
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
    ['changed quantity', (quotedItem) => { quotedItem.quantity = 2; }],
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

  test('stale cart totals invalidate the quote and fail closed', async () => {
    const quotedItem = item({
      productId: 701, variantId: 701, price: 3800,
      poolCents: 7600, cartCents: 7600, anchor: false,
    });
    const response = await request(app)
      .post('/rates')
      .send(payload([quotedItem], 7500, 'Stale Cart'))
      .expect(200);
    expect(response.body.rates[0].total_price).toBe('500');
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
