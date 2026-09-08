// Enable only after the checkout Function is installed and active. It discounts
// these base charges using all delivery groups; the carrier cannot do that.
export const checkoutFunctionActive = (env = process.env) =>
  env.SHOPIFY_NATIVE_SHIPPING_FUNCTION_ACTIVE === 'true';

export function functionCarrierRates({hasReadyStock, hasPreorder, feeCents = 699, currency = 'USD'}) {
  if (!hasReadyStock && !hasPreorder) return [];
  if (!Number.isSafeInteger(feeCents) || feeCents <= 0) throw new Error('Invalid shipping base fee');
  const mixed = hasReadyStock && hasPreorder;
  return [{
    service_name: mixed ? 'Ready-stock + preorder shipping' : hasPreorder ? 'Pre-Order Shipping' : 'Ships Now (In-Stock)',
    service_code: mixed ? 'MIXED_STD' : hasPreorder ? 'PO_STD' : 'RTS_STD',
    description: mixed ? 'Separate ready-stock and preorder shipping fees'
      : hasPreorder ? 'Free over $50 (ships during promised arrival window)' : 'Free over $50',
    total_price: String(feeCents * (mixed ? 2 : 1)), currency,
  }];
}
