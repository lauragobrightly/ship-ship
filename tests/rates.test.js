import request from 'supertest';
import app from '../server.js';

// Mock Redis
jest.mock('redis', () => ({
  createClient: () => ({
    connect: jest.fn(),
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    info: jest.fn().mockResolvedValue('memory info'),
    isReady: true,
    on: jest.fn()
  })
}));

// Mock fetch for GraphQL calls
global.fetch = jest.fn();

describe('Shipping Rates API', () => {
  const mockRateRequest = (items) => ({
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
        city: "New York"
      },
      items,
      currency: "USD",
      locale: "en"
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
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
