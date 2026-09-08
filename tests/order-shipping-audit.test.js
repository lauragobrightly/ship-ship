import {auditOrderShipping, summarizeShippingAudit} from '../lib/order-shipping-audit.js';
const item = (pool, price, extra = {}) => ({price, quantity: 1, requires_shipping: true,
  properties: [{name: '_shipping_bucket', value: pool}], discount_allocations: [], ...extra});
const shipping = (code, price, extra = {}) => ({code, price, discounted_price: price, ...extra});
const order = (items, lines, extra = {}) => ({id: 1, name: '#test', source_name: 'channel:11829400',
  shipping_address: {country_code: 'US'}, line_items: items, shipping_lines: lines, ...extra});
describe('completed-order shipping audit', () => {
  test('counts a completed undercharge, not a quote', () => {
    const r = auditOrderShipping(order([item('ready-stock', '38')], [shipping('RTS_STD', '0')]));
    expect(r.status).toBe('variance'); expect(r.underchargeCents).toBe(699);
  });
  test('uses allocated order discounts at the free-shipping boundary', () => {
    const r = auditOrderShipping(order([item('ready-stock', '50', {
      total_discount: '0', discount_allocations: [{amount: '5'}],
    })], [shipping('RTS_STD', '6.99')]));
    expect(r.status).toBe('matched'); expect(r.pools[0].subtotalCents).toBe(4500);
  });
  test('keeps economic pools independent and does not offset their errors', () => {
    const r = auditOrderShipping(order([item('ready-stock', '60'), item('preorder', '30')],
      [shipping('RTS_STD', '6.99'), shipping('PO_STD', '0')]));
    expect(r.underchargeCents).toBe(699); expect(r.overchargeCents).toBe(699);
  });
  test('one fee across warehouse groups; the next fee is an overcharge', () => {
    const o = order([item('ready-stock', '20'), item('ready-stock', '25')],
      [shipping('RTS_STD', '6.99'), shipping('RTS_STD', '0')]);
    expect(auditOrderShipping(o).status).toBe('matched');
    o.shipping_lines[1] = shipping('RTS_STD', '6.99');
    expect(auditOrderShipping(o).overchargeCents).toBe(699);
  });
  test('Function removal of duplicate base fees does not lower the policy fee', () => {
    const r = auditOrderShipping(order([item('ready-stock', '20'), item('ready-stock', '25')],
      [shipping('RTS_STD', '6.99'), shipping('RTS_STD', '6.99', {discounted_price: '0',
        discount_allocations: [{amount: '6.99', application: {
          __typename: 'AutomaticDiscountApplication', title: 'Ship Ship — one fee per fulfillment pool',
        }}]})]));
    expect(r.status).toBe('matched');
  });
  test('shipping promotions are reviewed rather than called lost revenue', () => {
    const r = auditOrderShipping(order([item('ready-stock', '38')],
      [shipping('RTS_STD', '6.99', {discounted_price: '0', discount_allocations: [{amount: '6.99'}]})]));
    expect(r.status).toBe('unknown'); expect(r.reason).toBe('shipping_promotion_requires_review');
  });
  test('missing metadata is unknown, never assumed ready stock', () => {
    const r = auditOrderShipping(order([item(null, '38')], [shipping('RTS_STD', '0')]));
    expect(r.status).toBe('unknown');
  });
  test('zero-dollar physical merchandise still has a fee unless exempted', () => {
    const r = auditOrderShipping(order([item('preorder', '0')], [shipping('PO_STD', '0')]));
    expect(r.underchargeCents).toBe(699);
  });
  test.each([{test: true}, {cancelled_at: '2026-09-08'}, {source_name: 'shopify_draft_order'},
    {shipping_address: {country_code: 'CA'}}])('excludes explicitly out-of-policy orders %j', extra => {
    expect(auditOrderShipping(order([item('ready-stock', '30')], [], extra)).status).toBe('excluded');
  });
  test('missing country and edited quantities remain unknown', () => {
    expect(auditOrderShipping(order([item('ready-stock', '30')], [], {shipping_address: {}})).status).toBe('unknown');
    expect(auditOrderShipping(order([item('ready-stock', '30', {current_quantity: 0})],
      [shipping('RTS_STD', '6.99')])).status).toBe('unknown');
  });
  test('summary deduplicates the same order across pages', () => {
    const o = order([item('ready-stock', '38')], [shipping('RTS_STD', '0')]);
    expect(summarizeShippingAudit([o, o])).toMatchObject({scanned: 1, underchargeCents: 699});
  });
});
