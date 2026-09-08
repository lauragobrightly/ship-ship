import {createHydraShopifyReader} from './order-audit-source.js';

export function compareShippingPools(variants, states) {
  const expected = new Map();
  for (const state of states) {
    const id = String(state.shopify_variant_id);
    const pool = ['PREORDER_OPEN', 'PREORDER_LOCKED'].includes(state.preorder_status) ? 'preorder' : 'ready-stock';
    if (expected.has(id) && expected.get(id) !== pool) throw new Error('Batchy returned conflicting variant states');
    expected.set(id, pool);
  }
  const drift = variants.flatMap(v => {
    // Batchy's carrier API also treats variants absent from its state table as RTS.
    const pool = expected.get(v.id.split('/').pop()) || 'ready-stock';
    return v.shippingPool?.value === pool ? [] : [{variantId: v.id, sku: v.sku,
      expected: pool, actual: v.shippingPool?.value || null}];
  });
  return {scanned: variants.length, drift};
}

export async function readShippingPoolCoverage({env = process.env, fetchImpl = fetch} = {}) {
  if (!env.BATCHY_API_KEY) throw new Error('Shipping coverage needs the Batchy API key');
  const response = await fetchImpl(new URL('/admin/variants', env.BATCHY_URL || 'https://batchy-production-0e03.up.railway.app'), {
    headers: {authorization: `Bearer ${env.BATCHY_API_KEY}`}, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Batchy coverage read HTTP ${response.status}`);
  const states = await response.json();
  if (!Array.isArray(states) || states.some(s => !s.shopify_variant_id || !s.preorder_status)) {
    throw new Error('Batchy coverage returned invalid variant states');
  }
  const query = await createHydraShopifyReader({env, fetchImpl});
  const variants = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const data = await query(`query ShippingCoverage($after: String) {
      productVariants(first:250, after:$after, query:"product_status:active") {
        nodes {id sku shippingPool:metafield(namespace:"custom",key:"shipping_pool"){value}}
        pageInfo {hasNextPage endCursor}
      }
    }`, {after});
    const c = data?.productVariants;
    if (!Array.isArray(c?.nodes) || !c.pageInfo) throw new Error('Invalid shipping coverage connection');
    variants.push(...c.nodes);
    if (!c.pageInfo.hasNextPage) return compareShippingPools(variants, states);
    if (!c.pageInfo.endCursor || c.pageInfo.endCursor === after) throw new Error('Coverage pagination did not advance');
    after = c.pageInfo.endCursor;
  }
  throw new Error('Shipping coverage audit was truncated');
}
