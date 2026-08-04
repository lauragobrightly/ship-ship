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
      total_price: "500",
      currency: "USD"
    });
  });

  test('RTS $60 → $5 carrier base; the Function applies free shipping', async () => {
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
      total_price: "500",
      currency: "USD"
    });
  });

  test('legacy callbacks fail closed per group; the Function applies cross-group free shipping', async () => {
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

    // The carrier callback has no whole-cart identity/subtotal here. It must not
    // combine potentially unrelated checkouts. The shipping Function's own
    // test suite proves the final $60 ready-stock pool discounts both options.
    const prices = [
      response1.body.rates[0]?.total_price,
      response2.body.rates[0]?.total_price
    ];
    console.log('Cross-location prices:', prices);
    expect(prices).toEqual(["500", "500"]);
  });

  test('legacy split callbacks do not wait for or borrow a late sibling subtotal', async () => {
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
    expect([r1.body.rates[0]?.total_price, r2.body.rates[0]?.total_price]).toEqual(["500", "500"]);
  });

  test('whole-cart totals never make a per-group carrier callback grant free shipping', async () => {
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
    const dest = {postal_code: "28104", address1: "Shopify Total Street"};

    const [first, second] = await Promise.all([
      request(app).post('/rates').send(mockRateRequest(mkItem('Split RTS A', 555555), dest, 7600)).expect(200),
      request(app).post('/rates').send(mockRateRequest(mkItem('Split RTS B', 666666), dest, 7600)).expect(200),
    ]);

    expect([first.body.rates[0]?.total_price, second.body.rates[0]?.total_price]).toEqual(["500", "500"]);
  });

  test('Mixed $30 RTS + $60 pre-order keeps independent $50 thresholds', async () => {
    const rtsItems = [{
      name: "Ready Stock Item",
      sku: "RTS-30",
      quantity: 1,
      grams: 200,
      price: 3000,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 777777,
      variant_id: 789012
    }];
    const preorderItems = [{
      name: "Jimothy Pre-Order",
      sku: "JIMOTHY-PO",
      quantity: 1,
      grams: 200,
      price: 6000,
      vendor: "Wildwoven",
      requires_shipping: true,
      taxable: true,
      fulfillment_service: "manual",
      product_id: 888888,
      variant_id: 999999,
      properties: [{name: "_shipping_bucket", value: "preorder"}]
    }];
    const dest = {postal_code: "98109", address1: "Independent Pools Street"};

    const [rts, preorder] = await Promise.all([
      request(app).post('/rates').send(mockRateRequest(rtsItems, dest, 9000)).expect(200),
      request(app).post('/rates').send(mockRateRequest(preorderItems, dest, 9000)).expect(200),
    ]);

    expect(rts.body.rates).toEqual(expect.arrayContaining([
      expect.objectContaining({service_code: "RTS_STD", total_price: "500"}),
    ]));
    expect(preorder.body.rates).toEqual(expect.arrayContaining([
      expect.objectContaining({service_code: "PO_STD", total_price: "500"}),
    ]));
  });

  test('an affirmative preorder marker is preserved across duplicate variant lines', async () => {
    const duplicateVariantItems = [
      {
        name: 'Marked preorder line',
        quantity: 1,
        price: 2500,
        product_id: 888888,
        variant_id: 789012,
        properties: [{key: '_shipping_bucket', value: 'preorder'}],
      },
      {
        name: 'Legacy duplicate line',
        quantity: 1,
        price: 2500,
        product_id: 888888,
        variant_id: 789012,
      },
    ];

    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest(duplicateVariantItems))
      .expect(200);

    expect(response.body.rates).toEqual([
      expect.objectContaining({service_code: 'PO_STD', total_price: '500'}),
    ]);
  });

  test('supports Shopify object-form line properties', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Object property preorder',
        quantity: 1,
        price: 5000,
        product_id: 888888,
        variant_id: 789013,
        properties: {_shipping_bucket: 'preorder'},
      }]))
      .expect(200);

    expect(response.body.rates[0]).toMatchObject({
      service_code: 'PO_STD',
      total_price: '500',
    });
  });

  test('uses Batchy for an unstamped accelerated-checkout preorder', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Unstamped preorder',
        quantity: 1,
        price: 5000,
        product_id: 888888,
        variant_id: 999998,
      }]))
      .expect(200);

    expect(response.body.rates[0]).toMatchObject({
      service_code: 'PO_STD',
      total_price: '500',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/variant-status/123456/999998'),
      expect.any(Object),
    );
  });

  test('does not trust an RTS marker to downgrade Batchy preorder truth', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Stale RTS marker',
        quantity: 1,
        price: 5000,
        product_id: 888888,
        variant_id: 999999,
        properties: [{name: '_shipping_bucket', value: 'rts'}],
      }]))
      .expect(200);

    expect(response.body.rates[0].service_code).toBe('PO_STD');
  });

  test('fails safely to ready-stock when Batchy is unavailable', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'Batchy outage item',
        quantity: 1,
        price: 5000,
        product_id: 888888,
        variant_id: 999997,
      }]))
      .expect(200);

    expect(response.body.rates[0]).toMatchObject({
      service_code: 'RTS_STD',
      total_price: '500',
    });
  });

  test('emits both base choices for an anomalous mixed callback', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([
        {
          name: 'RTS line', quantity: 1, price: 2500,
          product_id: 1, variant_id: 789015,
        },
        {
          name: 'PO line', quantity: 1, price: 2500,
          product_id: 2, variant_id: 789016,
          properties: [{name: '_shipping_bucket', value: 'preorder'}],
        },
      ]))
      .expect(200);

    expect(response.body.rates).toEqual(expect.arrayContaining([
      expect.objectContaining({service_code: 'RTS_STD', total_price: '500'}),
      expect.objectContaining({service_code: 'PO_STD', total_price: '500'}),
    ]));
  });

  test('an overlapping or ambiguous quote cannot grant free shipping', async () => {
    const item = (name, productId) => [{
      name,
      sku: name.toUpperCase().replace(/\s+/g, '-'),
      quantity: 1,
      grams: 200,
      price: 3000,
      vendor: 'Wildwoven',
      requires_shipping: true,
      taxable: true,
      fulfillment_service: 'manual',
      product_id: productId,
      variant_id: productId,
    }];
    const dest = {postal_code: '98109', address1: 'Collision Guard Street'};

    // These requests intentionally share the quote key and each claims to be a
    // complete $30 order. Their observed $60 cannot reconcile to either order,
    // so neither may borrow the other's subtotal.
    const [first, second] = await Promise.all([
      request(app).post('/rates').send(mockRateRequest(item('Cart A', 901), dest, 3000)).expect(200),
      request(app).post('/rates').send(mockRateRequest(item('Cart B', 902), dest, 3000)).expect(200),
    ]);

    expect([first.body.rates[0].total_price, second.body.rates[0].total_price]).toEqual(['500', '500']);
  });

  test('Single location $30 → still $5 (no cross-location boost)', async () => {
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

    expect(response.body.rates[0].total_price).toBe("500");
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

  test('international destinations defer to Shopify without calling Batchy', async () => {
    const response = await request(app)
      .post('/rates')
      .send(mockRateRequest([{
        name: 'International item', quantity: 1, price: 6000,
        product_id: 3, variant_id: 999998,
      }], {country: 'CA'}))
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
