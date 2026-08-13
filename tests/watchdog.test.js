import { classifyOrderShipping, msUntilPT } from '../watchdog.js';

const policy = { thresholdCents: 5000, feeCents: 500 };

describe('watchdog overcharge classifier', () => {
  test('single group over threshold charged the fee → flagged', () => {
    const order = { subtotal_price: '68.00', shipping_lines: [{ title: 'Ships Now', price: '5.00' }] };
    expect(classifyOrderShipping(order, policy)).toMatch(/single group at \$68.00/);
  });

  test('single group under threshold charged the fee → fine', () => {
    const order = { subtotal_price: '38.00', shipping_lines: [{ title: 'Ships Now', price: '5.00' }] };
    expect(classifyOrderShipping(order, policy)).toBeNull();
  });

  test('legitimate warehouse split (two $5 lines, $76 order) → fine', () => {
    const order = {
      subtotal_price: '76.00',
      shipping_lines: [{ title: 'Ships Now', price: '5.00' }, { title: 'Ships Later', price: '5.00' }],
    };
    expect(classifyOrderShipping(order, policy)).toBeNull();
  });

  test('international orders are exempt from the policy', () => {
    const order = {
      subtotal_price: '76.00',
      shipping_address: { country_code: 'GB' },
      shipping_lines: [{ title: 'Economy International', price: '22.71' }],
    };
    expect(classifyOrderShipping(order, policy)).toBeNull();
  });

  test('any line above the fee → flagged', () => {
    const order = { subtotal_price: '40.00', shipping_lines: [{ title: 'Ships Now', price: '12.00' }] };
    expect(classifyOrderShipping(order, policy)).toMatch(/over the fee/);
  });

  test('free shipping and mystery-box promo lines → ignored', () => {
    expect(classifyOrderShipping(
      { subtotal_price: '76.00', shipping_lines: [{ title: 'Ships Now', price: '0.00' }] }, policy)).toBeNull();
    expect(classifyOrderShipping(
      { subtotal_price: '80.00', shipping_lines: [{ title: 'Mystery Box Shipping', price: '8.00' }] }, policy)).toBeNull();
    expect(classifyOrderShipping({ subtotal_price: '30.00', shipping_lines: [] }, policy)).toBeNull();
  });
});

describe('watchdog scheduler', () => {
  test('msUntilPT lands within the coarse window of the target wall time', () => {
    const delay = msUntilPT(2, 30);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60_000 + 10 * 60_000);
  });

  test('weekly schedule stays within eight days', () => {
    const delay = msUntilPT(7, 0, 1);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(8 * 24 * 60 * 60_000);
  });
});
