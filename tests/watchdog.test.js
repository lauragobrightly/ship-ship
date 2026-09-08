import {msUntilPT, previousPacificDayWindow} from '../watchdog.js';

test('daily audit covers the full 25-hour Pacific fall-back day', () => {
  expect(previousPacificDayWindow(new Date('2026-11-02T15:00:00Z'))).toEqual({
    since: '2026-11-01T07:00:00.000Z', until: '2026-11-02T08:00:00.000Z',
  });
});
test('daily audit covers the full 23-hour Pacific spring-forward day', () => {
  expect(previousPacificDayWindow(new Date('2026-03-09T14:00:00Z'))).toEqual({
    since: '2026-03-08T08:00:00.000Z', until: '2026-03-09T07:00:00.000Z',
  });
});

describe('watchdog scheduler', () => {
  test('msUntilPT lands within the coarse window of the target wall time', () => {
    const delay = msUntilPT(2, 30);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60_000 + 10 * 60_000);
  });

  test('weekly schedule stays within eight days', () => {
    const delay = msUntilPT(7, 0, 1);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(8 * 24 * 60 * 60_000);
  });
});
