/**
 * Debounced customer-safe fallback alerts.
 *
 * A carrier callback that fails customer-safe ($0) is usually a transient race:
 * the customer edited the cart inside checkout, or an express-checkout button
 * added a line, and Shopify asked for rates before Hydrogen's re-stamp landed.
 * The next callback for the same destination, seconds later, carries a fresh
 * signed quote and prices correctly. Alerting on the first miss produced three
 * "investigate the checkout path" Slack posts on 2026-08-25 for carts that
 * were all priced correctly within two seconds.
 *
 * So: a fallback is HELD for `holdMs`. If a verified quote for the same
 * destination + pool arrives in that window, the alert is dropped. If not, it
 * is sent and says so. Rejections that are tamper-shaped (`invalid`) are still
 * sent immediately: those are never a race.
 */
export function createFallbackAlerter({
  sendAlert,
  holdMs = 90_000,
  cooldownMs = 15 * 60_000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = new Map();   // key -> {timer, payload}
  const lastSent = new Map();  // dedupeKey -> ts

  function describe({bucket, kind, quoteResult, groupSubtotal, held}) {
    const reason = kind === 'unsigned'
      ? 'No signed fulfillment-pool metadata reached the carrier.'
      : kind === 'invalid'
        ? 'Signed fulfillment-pool metadata failed verification.'
        : kind === 'stale'
          ? quoteResult?.reason
          : 'Shopify divided the under-$50 fee-anchor line across warehouse groups.';
    const poolTotal = Number.isFinite(quoteResult?.poolCents)
      ? `$${(quoteResult.poolCents / 100).toFixed(2)}`
      : 'unknown';
    const tail = held
      ? `No corrected quote was matched to this destination within ${Math.round(holdMs / 1000)}s. Checkout completion and the final shipping charge are unverified; check the completed order before counting lost revenue.`
      : 'A $0 rate was returned to prevent a duplicate warehouse fee. Quote verification failed; investigate the checkout path. Checkout completion and the final shipping charge are unverified.';
    return {
      title: `Ship Ship returned a $0 shipping quote: ${kind} ${bucket}`,
      body: [
        `Reason: ${reason}`,
        `Pool: ${bucket}`,
        `Signed pool total: ${poolTotal}`,
        `This warehouse callback subtotal: $${(groupSubtotal / 100).toFixed(2)}`,
        `Quote ID: ${quoteResult?.quoteId || 'missing'}`,
        tail,
      ].join('\n'),
      severity: 'warning',
      source: 'ship-ship-rates',
    };
  }

  function send(payload, held) {
    const dedupeKey = `${payload.bucket}:${payload.kind}:${payload.quoteResult?.quoteId || payload.cartKey}`;
    const t = now();
    if (t - (lastSent.get(dedupeKey) || 0) < cooldownMs) return false;
    lastSent.set(dedupeKey, t);
    void sendAlert(describe({...payload, held}));
    return true;
  }

  return {
    /** A group priced at $0 by a fallback. */
    fallback(payload) {
      const {cartKey, bucket, kind, suppress} = payload;
      if (!kind || suppress) return 'skipped';
      if (kind === 'invalid' || !cartKey) return send(payload, false) ? 'sent' : 'cooldown';
      const key = `${cartKey}:${bucket}`;
      if (pending.has(key)) return 'held';
      const timer = setTimer(() => {
        pending.delete(key);
        send(payload, true);
      }, holdMs);
      if (typeof timer?.unref === 'function') timer.unref();
      pending.set(key, {timer, payload});
      return 'held';
    },
    /** A verified signed quote priced this destination + pool: the race resolved. */
    resolved({cartKey, bucket}) {
      const key = `${cartKey}:${bucket}`;
      const entry = pending.get(key);
      if (!entry) return false;
      clearTimer(entry.timer);
      pending.delete(key);
      return true;
    },
    pendingCount: () => pending.size,
  };
}

/** Stable key for "the same shopper at checkout": destination, not cart contents (the cart is what changes). */
export function destinationKey(rate) {
  const d = rate?.destination || {};
  return [d.country || d.country_code || '', d.postal_code || '', d.province || '', (d.address1 || '').trim().toLowerCase()]
    .join('|');
}
