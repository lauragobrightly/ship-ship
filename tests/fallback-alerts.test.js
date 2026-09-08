import {jest} from '@jest/globals';
import {createFallbackAlerter, destinationKey} from '../lib/fallback-alerts.js';

function harness({holdMs = 1000, cooldownMs = 60_000} = {}) {
  let t = 1_000_000;
  const timers = [];
  const sendAlert = jest.fn(async () => {});
  const alerter = createFallbackAlerter({
    sendAlert, holdMs, cooldownMs,
    now: () => t,
    setTimer: (fn, ms) => { const h = {fn, at: t + ms}; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms) => { t += ms; for (const h of [...timers]) if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); } };
  return {alerter, sendAlert, advance};
}
const stale = (over = {}) => ({cartKey: 'US|98333|WA|1 main', bucket: 'ready-stock', kind: 'stale',
  quoteResult: {quoteId: 'q1', poolCents: 6800, reason: 'cart changed after stamping'}, groupSubtotal: 3800, ...over});

describe('fallback alert debounce', () => {
  test('a transient stale fallback that re-quotes within the hold window is never sent', () => {
    const {alerter, sendAlert, advance} = harness();
    expect(alerter.fallback(stale())).toBe('held');
    advance(200);
    expect(alerter.resolved({cartKey: stale().cartKey, bucket: 'ready-stock'})).toBe(true);
    advance(5000);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(alerter.pendingCount()).toBe(0);
  });

  test('a stale fallback with no corrected quote is sent after the hold and says so', () => {
    const {alerter, sendAlert, advance} = harness();
    alerter.fallback(stale());
    advance(999);
    expect(sendAlert).not.toHaveBeenCalled();
    advance(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const msg = sendAlert.mock.calls[0][0];
    expect(msg.title).toBe('Ship Ship returned a $0 shipping quote: stale ready-stock');
    expect(msg.body).toContain('No corrected quote was matched to this destination within 1s');
    expect(msg.body).toContain('Signed pool total: $68.00');
    expect(msg.body).toContain('This warehouse callback subtotal: $38.00');
  });

  test('repeated fallbacks for the same destination + pool collapse into one held alert', () => {
    const {alerter, sendAlert, advance} = harness();
    alerter.fallback(stale());
    alerter.fallback(stale({quoteResult: {quoteId: 'q2', poolCents: 6800, reason: 'x'}}));
    expect(alerter.pendingCount()).toBe(1);
    advance(1000);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  test('a resolution for a different pool does not cancel the hold', () => {
    const {alerter, sendAlert, advance} = harness();
    alerter.fallback(stale());
    expect(alerter.resolved({cartKey: stale().cartKey, bucket: 'preorder'})).toBe(false);
    advance(1000);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  test('tamper-shaped rejections are sent immediately, not held', () => {
    const {alerter, sendAlert} = harness();
    expect(alerter.fallback(stale({kind: 'invalid'}))).toBe('sent');
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0].body).toContain('Checkout completion and the final shipping charge are unverified');
  });

  test('cooldown still applies after a held alert is sent', () => {
    const {alerter, sendAlert, advance} = harness();
    alerter.fallback(stale()); advance(1000);
    alerter.fallback(stale()); advance(1000);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  test('suppressed probes and null kinds are skipped', () => {
    const {alerter, sendAlert} = harness();
    expect(alerter.fallback(stale({suppress: true}))).toBe('skipped');
    expect(alerter.fallback(stale({kind: null}))).toBe('skipped');
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test('destinationKey keys on where the shopper is, not what is in the cart', () => {
    const a = destinationKey({destination: {country: 'US', postal_code: '98333', province: 'WA', address1: '1 Main St '}});
    const b = destinationKey({destination: {country: 'US', postal_code: '98333', province: 'WA', address1: '1 main st'}});
    expect(a).toBe(b);
    expect(destinationKey({})).toBe('|||');
  });
});
