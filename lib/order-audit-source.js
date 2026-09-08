// All operational Shopify reads use Hydra's verified Wildwoven identity.
export const ORDER_AUDIT_QUERY = `query ShippingAudit($after: String, $search: String!) {
  orders(first: 50, after: $after, query: $search, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt test sourceName
      shippingAddress { countryCodeV2 }
      discountApplications(first: 100) {
        pageInfo { hasNextPage }
        nodes { __typename ... on AutomaticDiscountApplication { title }
          ... on DiscountCodeApplication { code }
          ... on ManualDiscountApplication { title } }
      }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes { quantity currentQuantity requiresShipping isGiftCard customAttributes { key value }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
        }
      }
      shippingLines(first: 100) {
        pageInfo { hasNextPage }
        nodes { code title isRemoved
          originalPriceSet { shopMoney { amount } }
          discountedPriceSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } }
            discountApplication { __typename ... on AutomaticDiscountApplication { title }
              ... on DiscountCodeApplication { code } ... on ManualDiscountApplication { title } }
          }
        }
      }
    }
  }
}`;

export function orderFromGraphQL(order) {
  if (order.lineItems.pageInfo.hasNextPage || order.shippingLines.pageInfo.hasNextPage ||
      order.discountApplications.pageInfo.hasNextPage) {
    throw new Error(`Shipping audit refuses truncated order ${order.name}`);
  }
  const allocations = entries => entries.map(a => ({
    amount: a.allocatedAmountSet.shopMoney.amount,
    application: a.discountApplication,
  }));
  return {id: order.id, name: order.name, created_at: order.createdAt,
    cancelled_at: order.cancelledAt, test: order.test, source_name: order.sourceName,
    shipping_address: {country_code: order.shippingAddress?.countryCodeV2},
    line_items: order.lineItems.nodes.map(l => ({quantity: l.quantity, current_quantity: l.currentQuantity,
      requires_shipping: l.requiresShipping, gift_card: l.isGiftCard,
      properties: l.customAttributes, price: l.originalUnitPriceSet.shopMoney.amount,
      discount_allocations: allocations(l.discountAllocations)})),
    shipping_lines: order.shippingLines.nodes.map(l => ({code: l.code, title: l.title,
      is_removed: l.isRemoved, price: l.originalPriceSet.shopMoney.amount,
      discounted_price: l.discountedPriceSet.shopMoney.amount,
      discount_allocations: allocations(l.discountAllocations)}))};
}

export async function createHydraShopifyReader({env = process.env, fetchImpl = fetch} = {}) {
  if (!env.HYDRA_URL || !env.HYDRA_API_KEY) throw new Error('Order audit needs HYDRA_URL and HYDRA_API_KEY');
  const base = new URL(env.HYDRA_URL);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('Order audit requires HTTPS for Hydra');
  }
  const call = async (path, body) => {
    const res = await fetchImpl(new URL(path, base), {
      method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${env.HYDRA_API_KEY}`},
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Hydra shipping audit HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Hydra shipping audit failed at ${data.stage || 'route'}`);
    return data;
  };
  const request = {tool: 'SHOPIFY_GRAPH_QL_QUERY', action: 'read', accountSlug: 'shopify:wildwoven',
    actor: 'ship-ship', context: {project: 'ship-ship', text: 'Read completed orders for shipping-charge reconciliation'}};
  const route = await call('/route', request);
  if (route.decision?.accountSlug !== request.accountSlug || route.decision?.requiresClarification ||
      route.decision?.requiresApproval) throw new Error('Hydra could not verify the shipping audit account');
  return async (query, variables) => {
    const out = await call('/execute', {...request, arguments: {query, variables}});
    if (!out.executed || out.stage !== 'executed' || out.result?.successful !== true ||
        out.result.error || out.result.data?.errors?.length) throw new Error('Hydra provider failed the shipping order query');
    if (out.result.data?.extensions?.search?.some(s => s.warnings?.length)) {
      throw new Error('Shopify rejected part of the shipping audit search filter');
    }
    return out.result.data?.data;
  };
}

export async function readAuditOrders({since, until = new Date().toISOString(),
  env = process.env, fetchImpl = fetch} = {}) {
  const query = await createHydraShopifyReader({env, fetchImpl});
  const start = Date.parse(since), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Invalid order audit time window');
  const search = `created_at:>=${JSON.stringify(since)} created_at:<${JSON.stringify(until)}`;
  const orders = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const data = await query(ORDER_AUDIT_QUERY, {after, search});
    const connection = data?.orders;
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error('Missing shipping order connection');
    if (connection.nodes.some(o => !Number.isFinite(Date.parse(o.createdAt)) ||
        Date.parse(o.createdAt) < start || Date.parse(o.createdAt) >= end)) {
      throw new Error('Shopify returned an order outside the requested audit window');
    }
    orders.push(...connection.nodes.map(orderFromGraphQL));
    if (!connection.pageInfo.hasNextPage) return orders;
    const next = connection.pageInfo.endCursor;
    if (!next || next === after) throw new Error('Shipping order pagination did not advance');
    after = next;
  }
  throw new Error('Shipping audit exceeded its pagination limit; results are incomplete');
}
