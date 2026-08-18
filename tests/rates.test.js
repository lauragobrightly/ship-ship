import request from 'supertest';
import {jest} from '@jest/globals';

const mockFetch = jest.fn(async (url) => {
  if (String(url).includes('/variants/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({variant: {product_id: 123456}}),
    };
  }
  if (String(url).includes('/api/v1/variant-status/')) {
    if (String(url).endsWith('/999997')) {
      throw new Error('Simulated Batchy outage');
    }
    const isPreOrder = /\/(999998|999999)$/.test(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        isPreOrder,
        status: isPreOrder ? 'PREORDER_OPEN' : 'IN_STOCK',
      }),
    };
  }
  throw new Error(`Unexpected network request in test: ${url}`);
});

jest.unstable_mockModule('node-fetch', () => ({default: mockFetch}));

const {default: app} = await import('../server.js');

describe('Shipping Rates API', () => {
  let defaultAddress;

  const mockRateRequest = (items, destOverride = {}, orderSubtotal) => ({
    rate: {
      origin: {
        country: "US",
        postal_code: "90210",
        province: "CA",
        city: "Beverly Hills"
      },
      destination: {
        country: "US",
        postal_code: "10001",
        province: "NY",
        city: "New York",
        address1: defaultAddress,
        ...destOverride
      },
      items,
      currency: "USD",
      locale: "en",
      ...(orderSubtotal === undefined ? {} : {
        order_totals: {
          subtotal_price: String(orderSubtotal),
          total_price: String(orderSubtotal),
          discount_amount: "0"
        }
      })
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    defaultAddress = `Test ${expect.getState().currentTestName}`;
  });

  test('RTS $30 → "Ships Now" $5', async () => {
    const items = [{
      name: "Test Product",
      sku: "TEST-SKU",
      quantity: 1,
      grams: 500,
      price: 3000,
      vendor: "Test Vendor",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 123456,
      variant_id: 789012
    }];

    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(items, {}, 3000))
      .expect(200);

    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({
      service_name: "Ships Now (In-Stock)",
      service_code: "RTS_STD",
      total_price: "0",
      currency: "USD"
    });
  });

  test('RTS $60 → "Ships Now" Free', async () => {
    const items = [{
      name: "Test Product",
      sku: "TEST-SKU", 
      quantity: 1,
      grams: 500,
      price: 6000,
      vendor: "Test Vendor",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 123456,
      variant_id: 789012
    }];

    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(items, {}, 6000))
      .expect(200);

    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({
      service_name: "Ships Now (In-Stock)",
      total_price: "0",
      currency: "USD"
    });
  });

  test('Cross-location split: $30 + $30 → both Free (combined $60 > $50)', async () => {
    const item1 = [{
      name: "LOTR Zip Romper",
      sku: "ZIP-LOTR",
      quantity: 1,
      grams: 500,
      price: 3000,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 111111,
      variant_id: 789012
    }];

    const item2 = [{
      name: "Gandalf Lovey",
      sku: "LOVEY-GANDALF",
      quantity: 1,
      grams: 200,
      price: 3000,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 222222,
      variant_id: 789012
    }];

    // Simulate two delivery group requests from same destination
    const [response1, response2] = await Promise.all([
      request(app)
        .post('/rates')
        .send(mockRateRequest(item1))
        .expect(200),
      request(app)
        .post('/rates')
        .send(mockRateRequest(item2))
        .expect(200)
    ]);

    // BOTH must be free. This used to assert only `toContain("0")` — at least one
    // free — which passes when one group is charged $5, i.e. it green-lit the exact
    // overcharge a customer reported on 2026-08-03.
    const prices = [
      response1.body.rates[0]?.total_price,
      response2.body.rates[0]?.total_price
    ];
    console.log('Cross-location prices:', prices);
    expect(prices).toEqual(["0", "0"]);
  });

  test('Cross-location split arriving 2s apart: $38 + $38 → both Free', async () => {
    // The real failure mode. Shopify does not guarantee that delivery-group
    // callbacks arrive together; when they were more than 750ms apart the first
    // one used to wake alone and charge $5. The first request must now wait for
    // its sibling instead of deciding on its own subtotal.
    const mkItem = (name, productId) => ([{
      name,
      sku: name.toUpperCase().replace(/\s+/g, '-'),
      quantity: 1,
      grams: 200,
      price: 3800,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: productId,
      variant_id: 789012
    }]);

    const dest = { postal_code: "28104", address1: "77 Skew Street" };

    const first = request(app)
      .post('/rates')
      .send(mockRateRequest(mkItem("Skew Romper", 333333), dest))
      .expect(200);

    // Sibling group lands 2s later — well past the old 750ms sleep.
    const second = new Promise(resolve => setTimeout(resolve, 2000)).then(() =>
      request(app)
        .post('/rates')
        .send(mockRateRequest(mkItem("Skew Pajamas", 444444), dest))
        .expect(200)
    );

    const [r1, r2] = await Promise.all([first, second]);
    expect([r1.body.rates[0]?.total_price, r2.body.rates[0]?.total_price]).toEqual(["0", "0"]);
  });

  test('Shopify order total makes a split $38 group free without waiting for a sibling', async () => {
    const items = [{
      name: "Split In-Stock Item",
      sku: "SPLIT-RTS",
      quantity: 1,
      grams: 200,
      price: 3800,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 555555,
      variant_id: 789012
    }];

    const started = Date.now();
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(
        items,
        {postal_code: "28104", address1: "Shopify Total Street"},
        7600
      ))
      .expect(200);

    expect(response.body.rates[0]?.total_price).toBe("0");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('Unsigned single-location $30 → customer-safe free', async () => {
    const items = [{
      name: "Small Item",
      sku: "SMALL",
      quantity: 1,
      grams: 200,
      price: 3000,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 333333,
      variant_id: 789012
    }];

    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(items, {}, 3000))
      .expect(200);

    expect(response.body.rates[0].total_price).toBe("0");
  });

  test('Gift cards only → Free shipping', async () => {
    const items = [{
      name: "Gift Card",
      sku: "GIFT-CARD",
      quantity: 1,
      grams: 0,
      price: 5000,
      vendor: "Test Store",
      requires_shipping: true,
      taxable: false,
      fulfillment_service: "manual",
      product_id: 123458,
      variant_id: 789014,
      product_type: "Gift Card"
    }];

    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(items))
      .expect(200);

    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({
      service_name: "Free Shipping",
      total_price: "0",
      description: "Gift cards ship free"
    });
  });

  test('an affirmative preorder marker survives a duplicate unstamped variant line', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([
        {
          name: 'Marked preorder', quantity: 1, price: 2500,
          product_id: 1, variant_id: 789020,
          properties: [{key: '_shipping_bucket', value: 'preorder'}],
        },
        {
          name: 'Unstamped duplicate', quantity: 1, price: 2500,
          product_id: 1, variant_id: 789020,
        },
      ], {}, 5000))
      .expect(200);

    expect(response.body.rates).toEqual([
      expect.objectContaining({service_code: 'PO_STD', total_price: '0'}),
    ]);
  });

  test('uses Batchy for an unstamped accelerated-checkout preorder', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Unstamped preorder', quantity: 1, price: 5000,
        product_id: 2, variant_id: 999998,
      }], {}, 5000))
      .expect(200);

    expect(response.body.rates[0]).toMatchObject({
      service_code: 'PO_STD', total_price: '0',
    });
  });

  test('does not trust an RTS marker to downgrade Batchy preorder truth', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Stale RTS marker', quantity: 1, price: 5000,
        product_id: 3, variant_id: 999999,
        properties: [{name: '_shipping_bucket', value: 'ready-stock'}],
      }], {}, 5000))
      .expect(200);

    expect(response.body.rates[0].service_code).toBe('PO_STD');
  });

  test('fails customer-safe when Batchy is unavailable', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Batchy outage item', quantity: 1, price: 3000,
        product_id: 4, variant_id: 999997,
      }], {}, 3000))
      .expect(200);

    expect(response.body.rates[0]).toMatchObject({
      service_code: 'RTS_STD', total_price: '0',
    });
  });

  test('emits independent choices for an anomalous mixed callback', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([
        {
          name: 'RTS line', quantity: 1, price: 2500,
          product_id: 5, variant_id: 789021,
        },
        {
          name: 'PO line', quantity: 1, price: 2500,
          product_id: 6, variant_id: 789022,
          properties: [{name: '_shipping_bucket', value: 'preorder'}],
        },
      ], {}, 5000))
      .expect(200);

    expect(response.body.rates).toEqual(expect.arrayContaining([
      expect.objectContaining({service_code: 'RTS_STD'}),
      expect.objectContaining({service_code: 'PO_STD'}),
    ]));
  });

  test('international destinations defer to Shopify without calling Batchy', async () => {
    jest.clearAllMocks();
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'International item', quantity: 1, price: 6000,
        product_id: 7, variant_id: 999998,
      }], {country: 'CA'}, 6000))
      .expect(200);

    expect(response.body).toEqual({rates: []});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('empty and malformed carrier payloads fail safely', async () => {
    await request(app).post('/rates').send({rate: {items: []}})
      .expect(200, {rates: []});
    await request(app).post('/rates').send({rate: {}})
      .expect(400, {error: 'Invalid rate request format'});
    await request(app).post('/rates').send({})
      .expect(400, {error: 'Invalid rate request format'});
  });
});
