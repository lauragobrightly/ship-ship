const FREE_SHIPPING_THRESHOLD_SHOP_CURRENCY = 50;
const PREORDER_BUCKET = 'preorder';
const READY_STOCK_BUCKET = 'ready-stock';
const SHIPPING_CLASS = 'SHIPPING';
const SERVICE_CODE_BUCKETS = new Map([
  ['RTS_STD', READY_STOCK_BUCKET],
  ['PO_STD', PREORDER_BUCKET],
]);

function money(value) {
  const amount = parseMoney(value);
  return amount !== null && amount > 0 ? amount : 0;
}

function parseMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function optionBucket(option) {
  const serviceCode = String(option?.code || '').trim().toUpperCase();
  if (SERVICE_CODE_BUCKETS.has(serviceCode)) {
    return SERVICE_CODE_BUCKETS.get(serviceCode);
  }

  // Title fallback supports legacy carrier responses where Shopify omits the
  // service code from Function input. Keep these exact so unrelated/localized
  // rates are never discounted by a loose substring match.
  const title = String(option?.title || '').toLowerCase();
  if (title === 'ships later (pre-order)') return PREORDER_BUCKET;
  if (title === 'ships now (in-stock)') return READY_STOCK_BUCKET;
  return null;
}

function discountCandidate(option, message) {
  return {
    message,
    targets: [{deliveryOption: {handle: option.handle}}],
    value: {percentage: {value: 100}},
  };
}

/**
 * Applies the final cross-delivery-group adjustment after Ship Ship Hooray has
 * returned its standard rate for each group. Ready-stock and preorder lines are
 * totaled independently. A qualifying bucket makes every Ship Ship option in
 * that bucket free. A non-qualifying bucket keeps one $5 group and discounts
 * duplicate location groups, so fulfillment splitting never multiplies fees.
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input?.discount?.discountClasses?.includes(SHIPPING_CLASS)) {
    return {operations: []};
  }

  const buckets = {
    [READY_STOCK_BUCKET]: {subtotal: 0, groups: []},
    [PREORDER_BUCKET]: {subtotal: 0, groups: []},
  };

  const presentmentRate = money(input?.presentmentCurrencyRate) || 1;
  const freeShippingThreshold =
    FREE_SHIPPING_THRESHOLD_SHOP_CURRENCY * presentmentRate;

  for (const group of input?.cart?.deliveryGroups || []) {
    const optionsByBucket = {
      [READY_STOCK_BUCKET]: [],
      [PREORDER_BUCKET]: [],
    };
    for (const option of group.deliveryOptions || []) {
      const bucket = optionBucket(option);
      if (bucket && option?.handle) optionsByBucket[bucket].push(option);
    }

    const optionBuckets = [READY_STOCK_BUCKET, PREORDER_BUCKET]
      .filter((bucket) => optionsByBucket[bucket].length > 0);

    // A valid virtual-warehouse group has exactly one Ship Ship promise. Two
    // promises in one group are ambiguous choices, not additive shipments.
    if (optionBuckets.length !== 1) continue;
    const bucket = optionBuckets[0];

    const lines = group.cartLines || [];
    if (lines.length === 0) continue;
    const hasExplicitPreorder = lines.some((line) =>
      line?.shippingBucket?.value === PREORDER_BUCKET
    );

    // An affirmative private line marker is never allowed to be downgraded by
    // an RTS carrier option. This conflict should not occur while the carrier
    // and Hydrogen are healthy, so fail closed instead of granting free rates.
    if (bucket === READY_STOCK_BUCKET && hasExplicitPreorder) continue;

    // The carrier option is the fallback classifier for accelerated and legacy
    // carts whose lines do not have Hydrogen's private attribute. It already
    // used Batchy to choose PO_STD versus RTS_STD.
    const lineTotals = lines.map((line) =>
      parseMoney(line?.cost?.totalAmount?.amount)
    );
    // A real zero-priced item can still create a delivery group and base
    // carrier fee, so include zero. Missing or malformed cost data is different:
    // fail that group closed because its threshold contribution is unknowable.
    if (lineTotals.some((amount) => amount === null)) continue;
    const groupTotal = lineTotals.reduce((sum, amount) => sum + amount, 0);

    buckets[bucket].subtotal += groupTotal;
    buckets[bucket].groups.push({
      id: group.id,
      options: optionsByBucket[bucket],
    });
  }

  const candidates = [];

  for (const bucket of [READY_STOCK_BUCKET, PREORDER_BUCKET]) {
    const state = buckets[bucket];
    const groups = [...state.groups].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    );

    const qualifying = state.subtotal >= freeShippingThreshold;
    const groupsToDiscount = qualifying ? groups : groups.slice(1);
    const message = qualifying
      ? `${bucket === PREORDER_BUCKET ? 'Preorder' : 'Ready-stock'} shipping free over $50`
      : 'One shipping fee per stock pool';

    for (const group of groupsToDiscount) {
      for (const option of group.options) {
        candidates.push(discountCandidate(option, message));
      }
    }
  }

  if (candidates.length === 0) return {operations: []};

  return {
    operations: [{
      deliveryDiscountsAdd: {
        candidates,
        selectionStrategy: 'ALL',
      },
    }],
  };
}
