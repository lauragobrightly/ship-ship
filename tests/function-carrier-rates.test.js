import {checkoutFunctionActive, functionCarrierRates} from '../lib/function-carrier-rates.js';
describe('checkout Function carrier contract', () => {
  test('is off unless explicitly enabled', () => {
    for (const value of [undefined, '', 'false', '1', true]) {
      expect(checkoutFunctionActive({SHOPIFY_NATIVE_SHIPPING_FUNCTION_ACTIVE: value})).toBe(false);
    }
    expect(checkoutFunctionActive({SHOPIFY_NATIVE_SHIPPING_FUNCTION_ACTIVE: 'true'})).toBe(true);
  });
  test.each([
    [true, false, 'RTS_STD', '699'], [false, true, 'PO_STD', '699'], [true, true, 'MIXED_STD', '1398'],
  ])('one stable option for RTS=%s PO=%s', (hasReadyStock, hasPreorder, code, price) => {
    const rates = functionCarrierRates({hasReadyStock, hasPreorder});
    expect(rates).toHaveLength(1); expect(rates[0]).toMatchObject({service_code: code, total_price: price, currency: 'USD'});
  });
  test('does not invent a shipment for an empty callback', () => {
    expect(functionCarrierRates({})).toEqual([]);
  });
});
