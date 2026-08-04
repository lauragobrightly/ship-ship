import {describe, expect, it} from 'vitest';
import {cartDeliveryOptionsDiscountsGenerateRun as run} from './cart_delivery_options_discounts_generate_run.js';

const rate = (bucket, subtotal, id, extras = {}) => ({
  id: `gid://shopify/CartDeliveryGroup/${id}`,
  cartLines: [{
    id: `gid://shopify/CartLine/${id}`,
    quantity: 1,
    shippingBucket: bucket === 'preorder' ? {value: 'preorder'} : null,
    cost: {
      subtotalAmount: {amount: String(subtotal)},
      totalAmount: {amount: String(subtotal)},
    },
  }],
  deliveryOptions: [
    {
      handle: `${id}-standard`,
      code: bucket === 'preorder' ? 'PO_STD' : 'RTS_STD',
      title: bucket === 'preorder'
        ? 'Ships Later (Pre-Order)'
        : 'Ships Now (In-Stock)',
      cost: {amount: '5.00'},
    },
    {handle: `${id}-express`, title: 'Express', cost: {amount: '18.00'}},
  ],
  ...extras,
});

const input = (groups, classes = ['SHIPPING']) => ({
  presentmentCurrencyRate: '1.0',
  cart: {deliveryGroups: groups},
  discount: {discountClasses: classes},
});

const discountedHandles = (result) =>
  result.operations.flatMap((operation) =>
    operation.deliveryDiscountsAdd?.candidates || []
  ).map((candidate) => candidate.targets[0].deliveryOption.handle).sort();

const payableStandardCosts = (groups, result) => {
  const freeHandles = new Set(discountedHandles(result));
  return groups.flatMap((group) =>
    group.deliveryOptions
      .filter((option) => option.title !== 'Express')
      .map((option) => freeHandles.has(option.handle) ? 0 : Number(option.cost.amount))
  );
};

describe('Wildwoven split-shipping discount', () => {
  it('does nothing without the shipping discount class', () => {
    expect(run(input([rate('ready-stock', 60, 'rts')], []))).toEqual({operations: []});
  });

  it('keeps one $5 ready-stock fee below $50', () => {
    expect(run(input([rate('ready-stock', 30, 'rts')]))).toEqual({operations: []});
  });

  it('makes a single ready-stock group free at $50', () => {
    expect(discountedHandles(run(input([rate('ready-stock', 50, 'rts')])))).toEqual(['rts-standard']);
  });

  it('combines same-bucket locations and removes duplicate fees below $50', () => {
    const result = run(input([
      rate('ready-stock', 20, 'a'),
      rate('ready-stock', 25, 'b'),
    ]));
    expect(discountedHandles(result)).toEqual(['b-standard']);
  });

  it('makes every same-bucket location free when their total reaches $50', () => {
    const result = run(input([
      rate('ready-stock', 30, 'a'),
      rate('ready-stock', 30, 'b'),
    ]));
    expect(discountedHandles(result)).toEqual(['a-standard', 'b-standard']);
  });

  it('keeps ready-stock and preorder thresholds independent', () => {
    const groups = [
      rate('ready-stock', 30, 'rts'),
      rate('preorder', 60, 'po'),
    ];
    const result = run(input(groups));
    expect(discountedHandles(result)).toEqual(['po-standard']);
    expect(payableStandardCosts(groups, result)).toEqual([5, 0]);
  });

  it.each([
    {ready: 49.99, preorder: null, expected: [5]},
    {ready: 50, preorder: null, expected: [0]},
    {ready: null, preorder: 49.99, expected: [5]},
    {ready: null, preorder: 50, expected: [0]},
    {ready: 30, preorder: 60, expected: [5, 0]},
    {ready: 60, preorder: 30, expected: [0, 5]},
    {ready: 30, preorder: 30, expected: [5, 5]},
    {ready: 60, preorder: 60, expected: [0, 0]},
  ])('produces final payable standard costs for ready=$ready preorder=$preorder', ({ready, preorder, expected}) => {
    const groups = [];
    if (ready !== null) groups.push(rate('ready-stock', ready, 'rts'));
    if (preorder !== null) groups.push(rate('preorder', preorder, 'po'));
    expect(payableStandardCosts(groups, run(input(groups)))).toEqual(expected);
  });

  it('holds the one-fee-per-pool invariant across threshold and location combinations', () => {
    const totals = [0, 0.01, 24.99, 49.99, 50, 50.01, 125];
    const locationCounts = [1, 2, 3];

    for (const readyTotal of totals) {
      for (const preorderTotal of totals) {
        for (const readyLocations of locationCounts) {
          for (const preorderLocations of locationCounts) {
            const groups = [];
            const addPool = (bucket, total, count) => {
              if (total === 0) return;
              const cents = Math.round(total * 100);
              const base = Math.floor(cents / count);
              for (let index = 0; index < count; index++) {
                const groupCents = index === count - 1
                  ? cents - base * (count - 1)
                  : base;
                groups.push(rate(
                  bucket,
                  groupCents / 100,
                  `${bucket}-${total}-${count}-${index}`,
                ));
              }
            };
            addPool('ready-stock', readyTotal, readyLocations);
            addPool('preorder', preorderTotal, preorderLocations);

            const payable = payableStandardCosts(groups, run(input(groups)))
              .reduce((sum, cost) => sum + cost, 0);
            const expected =
              (readyTotal > 0 && readyTotal < 50 ? 5 : 0) +
              (preorderTotal > 0 && preorderTotal < 50 ? 5 : 0);
            expect(payable, JSON.stringify({
              readyTotal,
              preorderTotal,
              readyLocations,
              preorderLocations,
            })).toBe(expected);
          }
        }
      }
    }
  });

  it('defaults unstamped legacy lines to ready-stock', () => {
    const group = rate('ready-stock', 60, 'legacy');
    delete group.cartLines[0].shippingBucket;
    expect(discountedHandles(run(input([group])))).toEqual(['legacy-standard']);
  });

  it('infers an unstamped legacy preorder group from PO_STD', () => {
    const group = rate('preorder', 60, 'legacy-po');
    delete group.cartLines[0].shippingBucket;
    expect(discountedHandles(run(input([group])))).toEqual(['legacy-po-standard']);
  });

  it('uses the carrier code even if a stale title says the opposite promise', () => {
    const group = rate('ready-stock', 60, 'coded');
    group.deliveryOptions[0].title = 'Ships Later (Pre-Order)';
    expect(discountedHandles(run(input([group])))).toEqual(['coded-standard']);
  });

  it('supports the exact legacy title when Shopify omits the carrier code', () => {
    const group = rate('preorder', 60, 'title-fallback');
    delete group.deliveryOptions[0].code;
    delete group.cartLines[0].shippingBucket;
    expect(discountedHandles(run(input([group])))).toEqual(['title-fallback-standard']);
  });

  it('does not match a loose or unrelated shipping title', () => {
    const group = rate('ready-stock', 60, 'unrelated');
    delete group.deliveryOptions[0].code;
    group.deliveryOptions[0].title = 'Ships Now-ish (In-Stock Express)';
    expect(run(input([group]))).toEqual({operations: []});
  });

  it('uses the post-discount line total for threshold qualification', () => {
    const group = rate('ready-stock', 60, 'discounted');
    group.cartLines[0].cost.totalAmount.amount = '45.00';
    expect(run(input([group]))).toEqual({operations: []});
  });

  it('sums multiple post-discount cart lines once without multiplying quantity', () => {
    const group = rate('ready-stock', 20, 'multi-line');
    group.cartLines[0].quantity = 3;
    group.cartLines.push({
      id: 'gid://shopify/CartLine/multi-line-2',
      quantity: 2,
      shippingBucket: null,
      cost: {totalAmount: {amount: '30.00'}},
    });
    expect(discountedHandles(run(input([group])))).toEqual(['multi-line-standard']);
  });

  it('converts the shop-currency threshold to presentment currency', () => {
    const group = rate('ready-stock', 45, 'presentment');
    const convertedInput = input([group]);
    convertedInput.presentmentCurrencyRate = '0.9';
    expect(discountedHandles(run(convertedInput))).toEqual(['presentment-standard']);
  });

  it('falls back to a 1:1 presentment rate when the rate is malformed', () => {
    const group = rate('ready-stock', 49.99, 'bad-rate');
    const malformedInput = input([group]);
    malformedInput.presentmentCurrencyRate = 'not-a-number';
    expect(run(malformedInput)).toEqual({operations: []});
  });

  it('removes all duplicate preorder location fees below $50 except one', () => {
    const groups = [
      rate('preorder', 10, 'c'),
      rate('preorder', 10, 'a'),
      rate('preorder', 10, 'b'),
    ];
    const result = run(input(groups));
    expect(discountedHandles(result)).toEqual(['b-standard', 'c-standard']);
    expect(payableStandardCosts(groups, result)).toEqual([0, 5, 0]);
  });

  it('is deterministic when Shopify changes delivery-group order', () => {
    const forward = [rate('ready-stock', 20, 'a'), rate('ready-stock', 20, 'b')];
    const reverse = [...forward].reverse();
    expect(discountedHandles(run(input(forward)))).toEqual(['b-standard']);
    expect(discountedHandles(run(input(reverse)))).toEqual(['b-standard']);
  });

  it('ignores empty groups and malformed or zero line totals', () => {
    const empty = rate('ready-stock', 10, 'empty');
    empty.cartLines = [];
    const malformed = rate('preorder', 10, 'malformed');
    malformed.cartLines[0].cost.totalAmount.amount = 'NaN';
    expect(run(input([empty, malformed]))).toEqual({operations: []});
  });

  it('deduplicates carrier fees for valid zero-value merchandise groups', () => {
    const groups = [
      rate('ready-stock', 0, 'free-a'),
      rate('ready-stock', 0, 'free-b'),
    ];
    const result = run(input(groups));
    expect(discountedHandles(result)).toEqual(['free-b-standard']);
    expect(payableStandardCosts(groups, result)).toEqual([5, 0]);
  });

  it('excludes an RTS group that conflicts with an affirmative preorder marker', () => {
    const conflict = rate('ready-stock', 100, 'conflict');
    conflict.cartLines[0].shippingBucket = {value: 'preorder'};
    const legitimate = rate('ready-stock', 10, 'legitimate');
    expect(run(input([conflict, legitimate]))).toEqual({operations: []});
  });

  it('excludes a group that presents both stock-pool carrier choices', () => {
    const ambiguous = rate('ready-stock', 100, 'ambiguous');
    ambiguous.deliveryOptions.push({
      handle: 'ambiguous-po',
      code: 'PO_STD',
      title: 'Ships Later (Pre-Order)',
      cost: {amount: '5.00'},
    });
    expect(run(input([ambiguous]))).toEqual({operations: []});
  });

  it('never discounts express options', () => {
    const handles = discountedHandles(run(input([rate('preorder', 60, 'po')])));
    expect(handles).toEqual(['po-standard']);
    expect(handles).not.toContain('po-express');
  });

  it('fails closed for a delivery group containing both stock pools', () => {
    const mixed = rate('ready-stock', 30, 'mixed');
    mixed.cartLines.push({
      id: 'gid://shopify/CartLine/mixed-po',
      quantity: 1,
      shippingBucket: {value: 'preorder'},
      cost: {
        subtotalAmount: {amount: '60'},
        totalAmount: {amount: '60'},
      },
    });
    expect(run(input([mixed]))).toEqual({operations: []});
  });
});
