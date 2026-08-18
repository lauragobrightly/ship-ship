/**
 * End-to-end cart permutation matrix for Ship Ship Hooray /rates.
 *
 * Unlike the jest suites (which mock the network), this signs quotes with the
 * REAL shared secret and posts real carrier callbacks at a running server —
 * local (node server.js) or production — so it exercises the Batchy fallback,
 * the Shopify variant lookup, the cross-group cache, and the signed-quote
 * verifier as actually wired.
 *
 * Usage:
 *   TARGET=http://localhost:3555 BATCHY_API_KEY=... node tests/permutation-matrix.mjs
 *   TARGET=https://ship-ship-production.up.railway.app BATCHY_API_KEY=... node tests/permutation-matrix.mjs
 *
 * Every scenario uses a unique destination so production probes cannot collide
 * with real customer callbacks in the cross-group cache (keyed on zip+address).
 *
 * Real catalog identities (2026-08-13):
 *   PO  = Local Legends Kids' Short Set  9325474185368
 *         49649429676184 (6-12, $30) / 49670061654168 (7/8) / 49670061686936 (9/10)
 *         — 7/8 and 9/10 were added to open batch B6 on 2026-08-11.
 *   RTS = LOTR Stained Glass Two-Piece   9191420461208 / 49246380949656 (2T, $38)
 */
import crypto from 'node:crypto';

const TARGET = process.env.TARGET || 'http://localhost:3555';
const SECRET = process.env.BATCHY_API_KEY;
if (!SECRET) { console.error('BATCHY_API_KEY is required'); process.exit(1); }

const RUN = crypto.randomBytes(3).toString('hex');

const PO = { productId: 9325474185368, variants: { '6-12': 49649429676184, '7/8': 49670061654168, '9/10': 49670061686936 }, price: 3000 };
const RTS = { productId: 9191420461208, variantId: 49246380949656, price: 3800 };

function sign({ version = '2', quoteId, bucket, poolCents, cartCents, currency = 'USD', productId, variantId, signedQuantity, anchor }) {
  return crypto.createHmac('sha256', SECRET)
    .update([version, quoteId, bucket, poolCents, cartCents, currency, productId, variantId, signedQuantity, anchor ? '1' : '0'].join('|'))
    .digest('hex');
}

/** Line properties exactly as the Hydrogen v2 signer emits them. */
function stamped({ version = '2', bucket, poolCents, cartCents, currency = 'USD', productId, variantId, signedQuantity, anchor, quoteId, tamper = {} }) {
  const props = {
    _shipping_bucket: bucket,
    _ww_ship_v: version,
    _ww_ship_quote: quoteId,
    _ww_ship_pool: bucket,
    _ww_ship_pool_cents: String(poolCents),
    _ww_ship_cart_cents: String(cartCents),
    _ww_ship_currency: currency,
    ...(version === '2' ? { _ww_ship_qty: String(signedQuantity) } : {}),
    _ww_ship_anchor: anchor ? '1' : '0',
    _ww_ship_sig: sign({ version, quoteId, bucket, poolCents, cartCents, currency, productId, variantId, signedQuantity, anchor }),
  };
  return { ...props, ...tamper };
}

function poItem({ variant = '6-12', quantity = 1, properties = { _shipping_bucket: 'preorder' } } = {}) {
  return {
    name: `Local Legends Kids' Short Set - ${variant}`,
    sku: `SHORTSET-LOCAL-LEGENDS-${variant}`,
    quantity,
    grams: 200,
    price: PO.price,
    product_id: PO.productId,
    variant_id: PO.variants[variant],
    requires_shipping: true,
    properties,
  };
}

function rtsItem({ quantity = 1, properties = null } = {}) {
  return {
    name: 'LOTR Stained Glass Two-Piece Pajama Set - 2T',
    sku: '2PIECEPJ-LOTR-TRILOGY-GLASS-2T',
    quantity,
    grams: 250,
    price: RTS.price,
    product_id: RTS.productId,
    variant_id: RTS.variantId,
    requires_shipping: true,
    properties,
  };
}

function rateRequest(scenarioId, items, { orderSubtotal, discountAmount = 0, country = 'US', currency = 'USD' } = {}) {
  return {
    rate: {
      origin: { country: 'US', postal_code: '33101', province: 'FL', city: 'Miami' },
      destination: { country, postal_code: '98101', province: 'WA', city: 'Seattle', address1: `test-${RUN}-${scenarioId}` },
      items,
      currency,
      ...(orderSubtotal !== undefined ? {
        order_totals: {subtotal_price: orderSubtotal, discount_amount: discountAmount},
      } : {}),
    },
  };
}

async function post(body) {
  const started = Date.now();
  const res = await fetch(`${TARGET}/rates`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Ship-Ship-Probe': 'matrix'},
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: Date.now() - started };
}

const summarize = (json) =>
  !json?.rates?.length
    ? 'EMPTY'
    : json.rates.map((r) => `${r.service_code}=$${(Number(r.total_price) / 100).toFixed(2)}`).sort().join(' ');

// ─── Scenario builders ──────────────────────────────────────────────────────

const qid = () => crypto.randomBytes(12).toString('hex');

/** A whole signed pool on one or more lines of one bucket. */
function signedPool({ version = '2', bucket, lines, poolCents, cartCents, currency = 'USD', tamperFirst = {} }) {
  const quoteId = qid();
  return lines.map(([builder, opts], index) =>
    builder({
      ...opts,
      properties: stamped({
        version,
        bucket,
        poolCents,
        cartCents,
        currency,
        productId: opts.productId,
        variantId: opts.variantId,
        signedQuantity: opts.signedQuantity,
        anchor: index === 0 ? (opts.anchor ?? true) : false,
        quoteId,
        tamper: index === 0 ? tamperFirst : {},
      }),
    }),
  );
}

const poSigned = (opts) => (o) => poItem({ variant: o.variant ?? '6-12', quantity: o.quantity, properties: o.properties });
const rtsSigned = () => (o) => rtsItem({ quantity: o.quantity, properties: o.properties });

function poPool({ version = '2', quantity, callbackQuantity, poolCents, cartCents, anchor = true, variant = '6-12', tamperFirst = {}, currency = 'USD' }) {
  return signedPool({
    version,
    bucket: 'preorder',
    poolCents,
    cartCents: cartCents ?? poolCents,
    currency,
    tamperFirst,
    lines: [[poSigned(), { variant, productId: PO.productId, variantId: PO.variants[variant], quantity: callbackQuantity ?? quantity, signedQuantity: quantity, anchor }]],
  });
}

function rtsPool({ version = '2', quantity, callbackQuantity, poolCents, cartCents }) {
  return signedPool({
    version,
    bucket: 'ready-stock',
    poolCents,
    cartCents: cartCents ?? poolCents,
    lines: [[rtsSigned(), { productId: RTS.productId, variantId: RTS.variantId, quantity: callbackQuantity ?? quantity, signedQuantity: quantity }]],
  });
}

// ─── The matrix ─────────────────────────────────────────────────────────────
// expect: sorted "CODE=$X.XX CODE=$X.XX" summary this build SHOULD return.

const scenarios = [
  // Unsigned carts (accelerated checkout / legacy — Batchy fallback path)
  { id: 'u01-rts-under', items: [rtsItem()], orderSubtotal: 3800, expect: 'RTS_STD=$0.00' },
  { id: 'u02-rts-over', items: [rtsItem({ quantity: 2 })], orderSubtotal: 7600, expect: 'RTS_STD=$0.00' },
  { id: 'u03-rts-just-under', items: [rtsItem()], orderSubtotal: 4999, expect: 'RTS_STD=$0.00' },
  { id: 'u04-po-marker-under', items: [poItem()], orderSubtotal: 3000, expect: 'PO_STD=$0.00' },
  { id: 'u05-po-marker-over', items: [poItem({ quantity: 2 })], orderSubtotal: 6000, expect: 'PO_STD=$0.00' },
  { id: 'u06-po-fallback-new-variant-under', items: [poItem({ variant: '9/10', properties: null })], orderSubtotal: 3000, expect: 'PO_STD=$0.00' },
  { id: 'u07-po-fallback-new-variant-over', items: [poItem({ variant: '9/10', quantity: 2, properties: null }), poItem({ variant: '7/8', properties: null })], orderSubtotal: 9000, expect: 'PO_STD=$0.00' },
  { id: 'u08-mixed-under-po-under', items: [rtsItem(), poItem()], orderSubtotal: 6800, expect: 'PO_STD=$0.00 RTS_STD=$0.00' },
  { id: 'u09-mixed-po-over', items: [rtsItem({ quantity: 2 }), poItem({ quantity: 2 })], orderSubtotal: 13600, expect: 'PO_STD=$0.00 RTS_STD=$0.00' },
  { id: 'u10-gift-card-only', items: [{ name: 'Gift Card', sku: 'GIFT-50', quantity: 1, grams: 0, price: 5000, product_id: 1, variant_id: 2, requires_shipping: false, product_type: 'Gift Card', properties: null }], orderSubtotal: 5000, expect: 'GIFT_CARD_FREE=$0.00' },
  { id: 'u11-international', items: [rtsItem()], orderSubtotal: 3800, country: 'CA', expect: 'EMPTY' },

  // v1 signed (regression — old storefront contract, unchanged semantics)
  { id: 'v1-01-po-over', items: poPool({ version: '1', quantity: 2, poolCents: 6000 }), orderSubtotal: 6000, expect: 'PO_STD=$0.00' },
  { id: 'v1-02-po-split-line', items: poPool({ version: '1', quantity: 2, callbackQuantity: 1, poolCents: 6000 }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' }, // v1 cannot survive a split; kept byte-identical deliberately
  { id: 'v1-03-tampered-pool', items: poPool({ version: '1', quantity: 2, poolCents: 3000, tamperFirst: { _ww_ship_pool_cents: '6000' } }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },

  // v2 signed (what the storefront deployed 2026-08-12 actually emits)
  { id: 'v2-01-po-over', items: poPool({ quantity: 2, poolCents: 6000 }), orderSubtotal: 6000, expect: 'PO_STD=$0.00' },
  { id: 'v2-02-po-split-line', items: poPool({ quantity: 2, callbackQuantity: 1, poolCents: 6000 }), orderSubtotal: 6000, expect: 'PO_STD=$0.00' }, // THE Aug 6 fix
  { id: 'v2-03-po-exactly-50', items: poPool({ quantity: 2, poolCents: 5000, cartCents: 5000 }), orderSubtotal: 5000, expect: 'PO_STD=$0.00' },
  { id: 'v2-04-po-under-anchor', items: poPool({ quantity: 1, poolCents: 3000 }), orderSubtotal: 3000, expect: 'PO_STD=$5.00' },
  { id: 'v2-05-po-under-anchor-elsewhere', items: poPool({ quantity: 1, poolCents: 3000, anchor: false }), orderSubtotal: 3000, expect: 'PO_STD=$0.00' }, // sibling group holds the fee anchor
  { id: 'v2-06-cb-qty-exceeds-signed', items: poPool({ quantity: 1, callbackQuantity: 2, poolCents: 6000 }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },
  { id: 'v2-07-tampered-pool-cents', items: poPool({ quantity: 2, poolCents: 3000, tamperFirst: { _ww_ship_pool_cents: '6000' } }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },
  { id: 'v2-08-missing-qty', items: poPool({ quantity: 2, poolCents: 6000, tamperFirst: { _ww_ship_qty: undefined } }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },
  { id: 'v2-09-wrong-pool-bucket', items: poPool({ quantity: 2, poolCents: 6000, tamperFirst: { _ww_ship_pool: 'ready-stock' } }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },
  { id: 'v2-10-currency-mismatch', items: poPool({ quantity: 2, poolCents: 6000, currency: 'EUR' }), orderSubtotal: 6000, expect: 'PO_STD=$5.00' },
  { id: 'v2-11-rts-over', items: rtsPool({ quantity: 2, poolCents: 7600 }), orderSubtotal: 7600, expect: 'RTS_STD=$0.00' },
  { id: 'v2-12-rts-split-line', items: rtsPool({ quantity: 2, callbackQuantity: 1, poolCents: 7600 }), orderSubtotal: 7600, expect: 'RTS_STD=$0.00' },
  {
    id: 'v2-12b-under-anchor-split',
    items: poPool({quantity: 4, callbackQuantity: 2, poolCents: 4000, cartCents: 4000})
      .map((item) => ({...item, price: 1000})),
    orderSubtotal: 4000,
    expect: 'PO_STD=$0.00',
  },
  {
    id: 'v2-13-mixed-both-pools-over',
    items: [
      ...rtsPool({ quantity: 2, poolCents: 7600, cartCents: 13600 }),
      ...poPool({ quantity: 2, poolCents: 6000, cartCents: 13600 }),
    ],
    orderSubtotal: 13600,
    expect: 'PO_STD=$0.00 RTS_STD=$0.00',
  },
  {
    id: 'v2-14-two-anchors',
    items: (() => {
      const quoteId = qid();
      const common = { version: '2', bucket: 'preorder', poolCents: 6000, cartCents: 6000, currency: 'USD', quoteId, anchor: true };
      return [
        poItem({ variant: '6-12', quantity: 1, properties: stamped({ ...common, productId: PO.productId, variantId: PO.variants['6-12'], signedQuantity: 1 }) }),
        poItem({ variant: '7/8', quantity: 1, properties: stamped({ ...common, productId: PO.productId, variantId: PO.variants['7/8'], signedQuantity: 1 }) }),
      ];
    })(),
    orderSubtotal: 6000,
    expect: 'PO_STD=$5.00',
  },
  {
    id: 'v2-15-stamped-plus-unstamped-line',
    items: [...poPool({ quantity: 1, poolCents: 6000, cartCents: 6000 }), poItem({ variant: '7/8' })],
    orderSubtotal: 6000,
    expect: 'PO_STD=$0.00', // stale, not tampered: fail customer-safe
  },

  // Staleness (honest carts whose stamps no longer match the checkout state).
  // These are the two modes that overcharged real customers 2026-08-06..13.
  { id: 's01-discount-code-po-over', items: poPool({ quantity: 2, poolCents: 5400, cartCents: 5400 }), orderSubtotal: 6000, discountAmount: 600, expect: 'PO_STD=$0.00' },
  { id: 's02-discount-code-rts-over', items: rtsPool({ quantity: 2, poolCents: 6840, cartCents: 6840 }), orderSubtotal: 7600, discountAmount: 760, expect: 'RTS_STD=$0.00' },
  { id: 's03-discount-code-po-under', items: poPool({ quantity: 1, poolCents: 2700, cartCents: 2700 }), orderSubtotal: 3000, discountAmount: 300, expect: 'PO_STD=$5.00' },
  { id: 's04-stale-customer-safe', items: poPool({ quantity: 1, poolCents: 7600, cartCents: 7600 }), orderSubtotal: 3000, expect: 'PO_STD=$0.00' },

  // Cross-group combining (two concurrent callbacks, same destination)
  {
    id: 'x01-po-cross-group-combine',
    concurrent: [
      { items: [poItem()], orderSubtotal: 5500 }, // $30 group
      { items: [{ ...poItem({ variant: '7/8' }), price: 2500 }], orderSubtotal: 5500 }, // $25 group
    ],
    expect: ['PO_STD=$0.00', 'PO_STD=$0.00'],
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

const results = [];
for (const scenario of scenarios) {
  if (scenario.concurrent) {
    const shared = `x-${RUN}-${scenario.id}`;
    const bodies = scenario.concurrent.map((group) => {
      const body = rateRequest(scenario.id, group.items, { orderSubtotal: group.orderSubtotal });
      body.rate.destination.address1 = shared; // same destination on purpose
      return body;
    });
    const responses = await Promise.all(bodies.map(post));
    const got = responses.map((r) => summarize(r.json));
    const pass = JSON.stringify(got.sort()) === JSON.stringify([...scenario.expect].sort());
    results.push({ id: scenario.id, expect: scenario.expect.join(' | '), got: got.join(' | '), pass, ms: Math.max(...responses.map((r) => r.ms)) });
  } else {
    const { items, orderSubtotal, discountAmount, country, expect } = scenario;
    const response = await post(rateRequest(scenario.id, items, { orderSubtotal, discountAmount, country }));
    const got = summarize(response.json);
    results.push({ id: scenario.id, expect, got, pass: got === expect, ms: response.ms });
  }
}

const failures = results.filter((r) => !r.pass);
console.log(`\nTarget: ${TARGET}  (run ${RUN})\n`);
const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(width)}  expect[${r.expect}]  got[${r.got}]  ${r.ms}ms`);
}
console.log(`\n${results.length - failures.length}/${results.length} scenarios match expectations`);
process.exit(failures.length ? 1 : 0);
