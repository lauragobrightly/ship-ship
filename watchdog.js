// watchdog.js — enforces the two fulfillment-pool shipping contract.
//
// Two standing checks, alerting through Collie's /alerts/paolo → Slack:
//   1. Nightly (2:30am PT): run the permutation matrix against THIS live
//      process. Silent when every scenario passes; alerts on any mismatch.
//   2. Weekly (Monday 7:00am PT): scan the last 7 days of Shopify orders for
//      shipping charges the policy can't explain. ALWAYS posts one line —
//      findings or "clean" — so a dead watchdog is visible within a week.
import { execFile } from 'child_process';
import fetch from 'node-fetch';

const ALERT_URL = process.env.COLLIE_ALERT_URL || 'https://collie-production.up.railway.app/alerts/paolo';
const ALERT_TOKEN = process.env.COLLIE_ALERT_TOKEN || '';
const ALERT_CHANNEL = process.env.COLLIE_ALERT_CHANNEL || '';

export async function sendAlert({ title, body, severity = 'info', source = 'ship-ship-watchdog' }) {
  if (!ALERT_TOKEN) {
    console.warn('[watchdog] COLLIE_ALERT_TOKEN not set; alert not sent:', title);
    return;
  }
  try {
    const res = await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ALERT_TOKEN}` },
      body: JSON.stringify({
        title,
        text: body,
        severity,
        source,
        ...(ALERT_CHANNEL ? {channel: ALERT_CHANNEL} : {}),
      }),
    });
    if (!res.ok) console.error('[watchdog] alert POST failed:', res.status, await res.text());
  } catch (err) {
    console.error('[watchdog] alert POST threw:', err.message);
  }
}

// Milliseconds until the next occurrence of hour:minute Pacific time,
// optionally on a specific weekday (0=Sun..6=Sat). DST-safe: walks forward in
// hours and reads the wall clock via Intl each step.
export function msUntilPT(hour, minute, weekday = null, from = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Coarse walk by 10 minutes over the next 8 days, take the first match.
  for (let step = 1; step <= 8 * 24 * 6; step++) {
    const t = new Date(from.getTime() + step * 10 * 60_000);
    const parts = Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]));
    if (Number(parts.hour) === hour && Math.abs(Number(parts.minute) - minute) < 5
        && (weekday === null || dayIndex[parts.weekday] === weekday)) {
      return t.getTime() - from.getTime();
    }
  }
  return 24 * 60 * 60_000; // unreachable fallback: try again in a day
}

function scheduleDaily(hour, minute, fn, label, weekday = null) {
  const arm = () => {
    const delay = msUntilPT(hour, minute, weekday);
    console.log(`[watchdog] ${label} next run in ${Math.round(delay / 60_000)} min`);
    setTimeout(async () => {
      try { await fn(); } catch (err) {
        console.error(`[watchdog] ${label} crashed:`, err.message);
        await sendAlert({ title: `Ship Ship watchdog crashed: ${label}`, body: err.message, severity: 'high' });
      }
      arm();
    }, delay).unref?.();
  };
  arm();
}

// ── Nightly matrix self-test ────────────────────────────────────────────────

export function runMatrixSelfTest(port) {
  return new Promise((resolve) => {
    execFile('node', ['tests/permutation-matrix.mjs'], {
      env: { ...process.env, TARGET: `http://127.0.0.1:${port}` },
      timeout: 5 * 60_000,
    }, async (err, stdout, stderr) => {
      const summary = (stdout.match(/(\d+\/\d+) scenarios match/) || [])[1] || 'no summary';
      const fails = stdout.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 10);
      if (err || fails.length) {
        console.error(`[watchdog] nightly matrix FAILED (${summary})`);
        await sendAlert({
          title: `Ship Ship nightly self-test FAILED: ${summary}`,
          body: fails.join('\n') || (stderr || String(err)).slice(0, 800),
          severity: 'high',
        });
      } else {
        console.log(`[watchdog] nightly matrix passed (${summary})`);
      }
      resolve({ summary, fails });
    });
  });
}

// ── Weekly overcharge sweep ─────────────────────────────────────────────────

function poolForShippingLine(line) {
  const code = String(line?.code || '').toUpperCase();
  const title = String(line?.title || '');
  if (code === 'RTS_STD' || /ships now|in-stock/i.test(title)) return 'ready-stock';
  if (code === 'PO_STD' || /pre-?order|ships later/i.test(title)) return 'preorder';
  return null;
}

function itemProperty(item, key) {
  const properties = item?.properties;
  if (Array.isArray(properties)) {
    return properties.find((property) =>
      (property?.name ?? property?.key) === key)?.value ?? null;
  }
  return properties?.[key] ?? null;
}

function lineItemCents(item) {
  if (item?.discounted_total !== undefined) {
    return Math.round(Number(item.discounted_total || 0) * 100);
  }
  const gross = Math.round(Number(item?.price || 0) * 100) * Number(item?.quantity || 0);
  const discount = Math.round(Number(item?.total_discount || 0) * 100);
  return Math.max(0, gross - discount);
}

// Pure classifier so it can be unit-tested. Physical Shopify delivery groups
// are not economic pools. Ready-stock may contribute at most one $6.99 charge and
// preorder may contribute at most one; either pool is free at $50.
export function classifyOrderShipping(order, { thresholdCents, feeCents }) {
  // Policy governs US shipments only; international rates legitimately exceed
  // the domestic fee (Economy International tiers, live carrier rates).
  const country = order.shipping_address?.country_code || 'US';
  if (country !== 'US') return null;
  const lines = (order.shipping_lines || []).filter(l =>
    !/mystery/i.test(l.title || '') && (l.code || '') !== 'MYSTERY_BOX_FLAT');
  if (!lines.length) return null;
  const centsOf = (v) => Math.round(Number(v || 0) * 100);
  const overFee = lines.filter(l => centsOf(l.price) > feeCents);
  if (overFee.length) {
    return `shipping line over the fee: ${overFee.map(l => `${l.title} $${l.price}`).join(', ')}`;
  }
  const poolLines = lines
    .map(line => ({ line, pool: poolForShippingLine(line), cents: centsOf(line.price) }))
    .filter(entry => entry.pool);
  for (const pool of ['ready-stock', 'preorder']) {
    const paidCents = poolLines
      .filter(entry => entry.pool === pool)
      .reduce((sum, entry) => sum + entry.cents, 0);
    if (paidCents > feeCents) {
      return `${pool} charged $${(paidCents / 100).toFixed(2)} across warehouse groups; maximum is $${(feeCents / 100).toFixed(2)}`;
    }
  }

  if (Array.isArray(order.line_items) && order.line_items.length) {
    const poolTotals = {'ready-stock': 0, preorder: 0};
    for (const item of order.line_items) {
      if (item?.requires_shipping === false) continue;
      const marker = itemProperty(item, '_shipping_bucket');
      const pool = marker === 'preorder' ? 'preorder' : 'ready-stock';
      poolTotals[pool] += lineItemCents(item);
    }
    for (const pool of ['ready-stock', 'preorder']) {
      const paidCents = poolLines
        .filter(entry => entry.pool === pool)
        .reduce((sum, entry) => sum + entry.cents, 0);
      if (paidCents > 0 && poolTotals[pool] >= thresholdCents) {
        return `${pool} pool at $${(poolTotals[pool] / 100).toFixed(2)} charged $${(paidCents / 100).toFixed(2)} shipping`;
      }
    }
  }
  return null;
}

export async function runOverchargeSweep({ thresholdCents, feeCents }) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;
  // The app's own token is scoped to products/variants; order reads need the
  // ops admin token (SWEEP_SHOPIFY_TOKEN on Railway).
  const token = process.env.SWEEP_SHOPIFY_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  let url = `https://${domain}/admin/api/2024-07/orders.json?status=any&created_at_min=${since}&limit=250`
    + `&fields=name,created_at,email,subtotal_price,shipping_lines,shipping_address,line_items`;
  const flagged = [];
  let scanned = 0;
  for (let page = 0; page < 8 && url; page++) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`orders fetch ${res.status}`);
    const orders = (await res.json()).orders || [];
    scanned += orders.length;
    for (const order of orders) {
      const reason = classifyOrderShipping(order, { thresholdCents, feeCents });
      if (reason) flagged.push(`${order.name} (${order.email}): ${reason}`);
    }
    const link = res.headers.get('link') || '';
    const next = link.split(',').find(part => part.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)?.[1] : null;
  }
  const title = flagged.length
    ? `Ship Ship weekly sweep: ${flagged.length} suspicious shipping charge(s) in ${scanned} orders`
    : `Ship Ship weekly sweep clean: ${scanned} orders, no unexplained shipping charges`;
  await sendAlert({
    title,
    body: flagged.slice(0, 15).join('\n'),
    severity: flagged.length ? 'warning' : 'low',
  });
  console.log(`[watchdog] weekly sweep: ${scanned} scanned, ${flagged.length} flagged`);
  return { scanned, flagged };
}

// ── Boot ────────────────────────────────────────────────────────────────────

export function startWatchdogs({ port, thresholdCents, feeCents }) {
  if (process.env.WATCHDOG_ENABLED === 'false') {
    console.log('[watchdog] disabled via WATCHDOG_ENABLED=false');
    return;
  }
  scheduleDaily(2, 30, () => runMatrixSelfTest(port), 'nightly matrix self-test');
  scheduleDaily(7, 0, () => runOverchargeSweep({ thresholdCents, feeCents }), 'weekly overcharge sweep', 1);
  console.log('[watchdog] armed: nightly matrix 2:30am PT, weekly sweep Mon 7:00am PT');
}
