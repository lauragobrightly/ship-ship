import request from 'supertest';
import app from '../server.js';

// Mock Redis with in-memory store for cross-location tests
const redisStore = {};
jest.mock('redis', () => ({
  createClient: () => ({
    connect: jest.fn(),
    get: jest.fn((key) => Promise.resolve(redisStore[key] || null)),
    set: jest.fn((key, value, opts) => {
      redisStore[key] = value;
      return Promise.resolve('OK');
    }),
    setEx: jest.fn((key, ttl, value) => {
      redisStore[key] = value;
      return Promise.resolve('OK');
    }),
    del: jest.fn((key) => {
      delete redisStore[key];
      return Promise.resolve(1);
    }),
    keys: jest.fn((pattern) => {
      const prefix = pattern.replace('*', '');
      const matches = Object.keys(redisStore).filter(k => k.startsWith(prefix));
      return Promise.resolve(matches);
    }),
    mGet: jest.fn((keys) => {
      return Promise.resolve(keys.map(k => redisStore[k] || null));
    }),
    info: jest.fn().mockResolvedValue('memory info'),
    isReady: true,
    on: jest.fn()
  })
}));

// Mock fetch for GraphQL calls
global.fetch = jest.fn();

describe('Shipping Rates API', () => {
  const mockRateRequest = (items, destOverride = {}) => ({
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
        ...destOverride
      },
      items,
      currency: "USD",
      locale: "en"
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear Redis store between tests
    for (const key of Object.keys(redisStore)) {
      delete redisStore[key];
    }

    // Mock GraphQL response
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/789012",
              metafield: null
            }
          ]
        }
      })
    });
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
      .send(mockRateRequest(items))
      .expect(200);

    expect(response.body.rates).toHaveLength(1);
    expect(response.body.rates[0]).toMatchObject({
      service_name: "Ships Now (In-Stock)",
      service_code: "RTS_STD",
      total_price: "500",
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
      .send(mockRateRequest(items))
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
      .send(mockRateRequest(items))
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
});
