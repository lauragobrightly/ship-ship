import {compareShippingPools} from '../lib/shipping-pool-coverage.js';
test('compares exact variants rather than product-wide tags', () => {
  const variants = [
    {id:'gid://shopify/ProductVariant/1',sku:'SIZE-S',shippingPool:{value:'preorder'}},
    {id:'gid://shopify/ProductVariant/2',sku:'SIZE-M',shippingPool:{value:'ready-stock'}},
  ];
  expect(compareShippingPools(variants,[{shopify_variant_id:'1',preorder_status:'PREORDER_OPEN'}]).drift).toEqual([]);
});
test('detects new missing fields and stale classifications', () => {
  const r=compareShippingPools([{id:'gid://shopify/ProductVariant/1'},
    {id:'gid://shopify/ProductVariant/2',shippingPool:{value:'ready-stock'}}],
    [{shopify_variant_id:'2',preorder_status:'PREORDER_LOCKED'}]);
  expect(r.drift.map(d=>d.expected)).toEqual(['ready-stock','preorder']);
});
test('conflicting Batchy rows cannot silently determine a pool', () => {
  expect(()=>compareShippingPools([], [{shopify_variant_id:'1',preorder_status:'PREORDER_OPEN'},
    {shopify_variant_id:'1',preorder_status:'IN_STOCK'}])).toThrow('conflicting');
});
