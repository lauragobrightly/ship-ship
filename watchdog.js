// watchdog.js — enforces the two fulfillment-pool shipping contract.
//
// Two standing checks, alerting through Collie's /alerts/paolo → Slack:
//   1. Nightly (2:30am PT): run the permutation matrix against THIS live
//      process. Silent when every scenario passes; alerts on any mismatch.
//   2. Daily (7:00am PT): audit completed orders through Hydra for both
//      undercharges and overcharges; report unknown classifications explicitly.
import { execFile } from 'child_process';
import fetch from 'node-fetch';
import {summarizeShippingAudit} from './lib/order-shipping-audit.js';
import {readAuditOrders} from './lib/order-audit-source.js';
import {readShippingPoolCoverage} from './lib/shipping-pool-coverage.js';

const ALERT_URL = process.env.COLLIE_ALERT_URL || 'https://collie-production.up.railway.app/alerts/paolo';
const ALERT_TOKEN = process.env.COLLIE_ALERT_TOKEN || '';
const ALERT_CHANNEL = process.env.COLLIE_ALERT_CHANNEL || '';

export async function sendAlert({ title, body, severity = 'info', source = 'ship-ship-watchdog' }) {
  if (!ALERT_TOKEN) {
    console.warn('[watchdog] COLLIE_ALERT_TOKEN not set; alert not sent:', title);
    return false;
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
    if (!res.ok) console.error('[watchdog] alert POST failed:', res.status);
    return res.ok;
  } catch (err) {
    console.error('[watchdog] alert POST threw:', err.message);
    return false;
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

// A full Pacific calendar day avoids gaps when daylight saving time changes.
export function previousPacificDayWindow(now) {
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  const today = Date.parse(`${date}T00:00:00Z`);
  const wall = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const midnight = target => {
    let candidate = target;
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(wall.formatToParts(new Date(candidate)).map(x => [x.type, x.value]));
      const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      candidate += target - represented;
    }
    return new Date(candidate).toISOString();
  };
  return {since: midnight(today - 86400000), until: midnight(today)};
}

// One daily completed-order summary; quote warnings remain separate diagnostics.
export async function runShippingAudit({thresholdCents, feeCents,
  readOrders = readAuditOrders, readCoverage = readShippingPoolCoverage, report = sendAlert, now = new Date()} = {}) {
  const {since, until} = previousPacificDayWindow(now);
  const orders = await readOrders({since, until});
  const audit = summarizeShippingAudit(orders, {thresholdCents, feeCents});
  try { audit.coverage = await readCoverage(); }
  catch (error) { audit.coverage = {error: error.message}; }
  const amount = c => `$${(c / 100).toFixed(2)}`;
  const title = `Ship Ship order audit: ${audit.scanned} orders, `
    + `${amount(audit.underchargeCents)} undercharged, ${amount(audit.overchargeCents)} overcharged, `
    + `${audit.unknown.length} need classification review`;
  const body = [
    `Completed orders created ${since} to ${until}.`,
    `${audit.matched} matched the recorded pool policy; ${audit.excluded} excluded.`,
    ...audit.variances.slice(0, 15).map(r => `${r.orderName}: ` + r.pools.map(p =>
      `${p.pool} subtotal ${amount(p.subtotalCents)}, expected ${amount(p.expectedCents)}, paid ${amount(p.paidCents)}`).join('; ')),
    ...audit.unknown.slice(0, 10).map(r => `${r.orderName}: unverified (${r.reason})`),
    audit.coverage.error ? `Catalog classification check failed: ${audit.coverage.error}`
      : `Catalog: ${audit.coverage.scanned} active variants checked; ${audit.coverage.drift.length} pool mismatches.`,
    ...(audit.coverage.drift || []).slice(0, 10).map(v => `${v.sku || v.variantId}: expected ${v.expected}, recorded ${v.actual || 'missing'}`),
    'Based on purchase-time order attributes. Checkout quote warnings are not completed-order losses.',
  ].join('\n');
  const accepted = await report({title, body, severity: audit.variances.length || audit.unknown.length ||
    audit.coverage.error || audit.coverage.drift?.length ? 'warning' : 'low'});
  if (accepted === false) throw new Error('Completed-order report was not accepted by the alert endpoint');
  console.log(`[watchdog] completed-order audit: ${audit.scanned} scanned, ${audit.variances.length} variances, ${audit.unknown.length} unknown`);
  return audit;
}

// ── Boot ────────────────────────────────────────────────────────────────────

export function startWatchdogs({ port, thresholdCents, feeCents }) {
  if (process.env.WATCHDOG_ENABLED === 'false') {
    console.log('[watchdog] disabled via WATCHDOG_ENABLED=false');
    return;
  }
  scheduleDaily(2, 30, () => runMatrixSelfTest(port), 'nightly matrix self-test');
  scheduleDaily(7, 0, () => runShippingAudit({ thresholdCents, feeCents }), 'daily completed-order audit');
  console.log('[watchdog] armed: nightly matrix 2:30am PT, daily order audit 7:00am PT');
}
