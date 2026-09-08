// Audit completed orders from their recorded purchase-time pool classification.
// Current catalog state cannot tell us what a variant was when it was purchased.
const POOLS = ['ready-stock', 'preorder'];
const codes = {RTS_STD: 'ready-stock', PO_STD: 'preorder'};
const property = (line, name) => Array.isArray(line.properties)
  ? line.properties.find(p => (p.name ?? p.key) === name)?.value
  : line.properties?.[name];

function cents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function money(line, field) {
  return cents(line[`${field}_set`]?.shop_money?.amount ?? line[field]);
}

export function auditOrderShipping(order, {thresholdCents = 5000, feeCents = 699,
  policyDiscountTitle = 'Ship Ship — one fee per fulfillment pool'} = {}) {
  const result = (status, reason, detail = {}) => ({
    orderId: order.id == null ? null : String(order.id), orderName: order.name,
    status, reason, ...detail,
  });
  if (order.test || order.cancelled_at) return result('excluded', 'test_or_cancelled');
  if (order.source_name === 'shopify_draft_order') return result('excluded', 'manual_draft_order');
  const country = order.shipping_address?.country_code;
  if (!country) return result('unknown', 'missing_destination_country');
  if (country !== 'US') return result('excluded', 'international');
  if (!Array.isArray(order.line_items)) return result('unknown', 'missing_order_items');
  const items = order.line_items.filter(l => l.requires_shipping !== false && !l.gift_card);
  if (!items.length) return result('excluded', 'no_shippable_items');
  const lines = (order.shipping_lines || []).filter(l => !l.is_removed);
  if (lines.some(l => l.code === 'MYSTERY_BOX_FLAT' || /mystery/i.test(l.title || ''))) {
    return result('excluded', 'shipping_promotion');
  }
  if (!lines.length) return result('unknown', 'missing_shipping_lines');
  if (lines.some(l => !codes[l.code])) return result('unknown', 'unrecognized_shipping_code');
  const poolTotals = Object.fromEntries(POOLS.map(p => [p, 0]));
  const poolPresent = new Set();
  for (const item of items) {
    const pool = property(item, '_shipping_bucket');
    const signedPool = property(item, '_ww_ship_pool');
    if (!POOLS.includes(pool) || property(item, '_ww_ship_guess') === '1' ||
        (signedPool && signedPool !== pool)) return result('unknown', 'missing_or_conflicting_purchase_time_pool');
    const price = money(item, 'price');
    if (price === null || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return result('unknown', 'invalid_item_amount');
    }
    if (item.current_quantity !== undefined && item.current_quantity !== item.quantity) {
      return result('unknown', 'edited_or_refunded_order');
    }
    const gross = price * item.quantity;
    let discount = 0;
    if (Array.isArray(item.discount_allocations)) {
      for (const allocation of item.discount_allocations) {
        const amount = cents(allocation.amount_set?.shop_money?.amount ?? allocation.amount);
        if (amount === null) return result('unknown', 'invalid_item_discount');
        discount += amount;
      }
    } else {
      discount = money(item, 'total_discount') ?? 0;
    }
    if (discount > gross) return result('unknown', 'invalid_item_discount');
    poolTotals[pool] += gross - discount;
    poolPresent.add(pool);
  }
  const poolPaid = Object.fromEntries(POOLS.map(p => [p, 0]));
  for (const line of lines) {
    const pool = codes[line.code];
    if (!poolPresent.has(pool)) return result('unknown', 'shipping_pool_without_items');
    const original = money(line, 'price');
    let paid = money(line, 'discounted_price');
    let allocated = 0;
    for (const allocation of line.discount_allocations || []) {
      const amount = cents(allocation.amount_set?.shop_money?.amount ?? allocation.amount);
      if (amount === null) return result('unknown', 'invalid_shipping_discount');
      allocated += amount;
      const app = allocation.application || order.discount_applications?.[allocation.discount_application_index];
      if (amount > 0 && !((app?.__typename === 'AutomaticDiscountApplication' || app?.type === 'automatic') &&
          app.title === policyDiscountTitle)) return result('unknown', 'shipping_promotion_requires_review');
    }
    if (paid === null && original !== null) paid = original - allocated;
    if (original === null || paid === null || paid < 0 || paid > original ||
        (allocated > 0 && original - paid !== allocated)) return result('unknown', 'invalid_shipping_amount');
    poolPaid[pool] += paid;
    if (original - paid !== allocated) return result('unknown', 'unattributed_shipping_discount');
  }
  // Missing a shipping line for one mixed-cart pool is ambiguous, not zero.
  if ([...poolPresent].some(p => !lines.some(l => codes[l.code] === p))) {
    return result('unknown', 'missing_pool_shipping_line');
  }
  const pools = [...poolPresent].map(pool => {
    const base = poolTotals[pool] < thresholdCents ? feeCents : 0;
    const expectedCents = base;
    return {pool, subtotalCents: poolTotals[pool], expectedCents,
      paidCents: poolPaid[pool], varianceCents: poolPaid[pool] - expectedCents};
  });
  const underchargeCents = pools.reduce((n, p) => n + Math.max(0, -p.varianceCents), 0);
  const overchargeCents = pools.reduce((n, p) => n + Math.max(0, p.varianceCents), 0);
  return result(underchargeCents || overchargeCents ? 'variance' : 'matched',
    'recorded_order_pool_comparison', {pools, underchargeCents, overchargeCents,
      confidence: 'purchase_time_attributes'});
}

export function summarizeShippingAudit(orders, policy) {
  const unique = new Map();
  for (const order of orders) {
    if (order.id == null) throw new Error('Order audit requires stable order IDs');
    unique.set(String(order.id), order);
  }
  const results = [...unique.values()].map(o => auditOrderShipping(o, policy));
  return {scanned: results.length,
    matched: results.filter(r => r.status === 'matched').length,
    excluded: results.filter(r => r.status === 'excluded').length,
    unknown: results.filter(r => r.status === 'unknown'),
    variances: results.filter(r => r.status === 'variance'),
    underchargeCents: results.reduce((n, r) => n + (r.underchargeCents || 0), 0),
    overchargeCents: results.reduce((n, r) => n + (r.overchargeCents || 0), 0)};
}
