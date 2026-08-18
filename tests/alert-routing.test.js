import {jest} from '@jest/globals';

process.env.COLLIE_ALERT_TOKEN = 'test-token';
process.env.COLLIE_ALERT_CHANNEL = 'C_ALERTS';

const mockFetch = jest.fn(async () => ({ok: true}));
jest.unstable_mockModule('node-fetch', () => ({default: mockFetch}));

const {sendAlert} = await import('../watchdog.js');

describe('Collie alert routing', () => {
  test('targets the configured Slack channel without changing alert content', async () => {
    await sendAlert({
      title: 'Shipping warning',
      body: 'Threshold crossed',
      severity: 'warning',
      source: 'ship-ship-rates',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      title: 'Shipping warning',
      text: 'Threshold crossed',
      severity: 'warning',
      source: 'ship-ship-rates',
      channel: 'C_ALERTS',
    });
  });
});
