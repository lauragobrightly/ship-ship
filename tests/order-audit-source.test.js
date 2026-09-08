import {jest} from '@jest/globals';
import {readAuditOrders} from '../lib/order-audit-source.js';
import {runShippingAudit} from '../watchdog.js';
const env = {HYDRA_URL: 'https://hydra.example', HYDRA_API_KEY: 'fixture'};
const route = {ok: true, decision: {accountSlug: 'shopify:wildwoven'}};
const page = (hasNextPage = false, endCursor = null) => ({ok: true, executed: true, stage: 'executed',
  result: {successful: true, data: {data: {orders: {nodes: [], pageInfo: {hasNextPage, endCursor}}}}}});
const response = data => ({ok: true, json: async () => data});
test('reads every page through the verified Hydra account', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(route))
    .mockResolvedValueOnce(response(page(true, 'next'))).mockResolvedValueOnce(response(page()));
  expect(await readAuditOrders({since: '2026-09-08T07:00:00Z', env, fetchImpl})).toEqual([]);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  const body = JSON.parse(fetchImpl.mock.calls[2][1].body);
  expect(body).toMatchObject({action: 'read', accountSlug: 'shopify:wildwoven',
    arguments: {variables: {after: 'next'}}});
  expect(body.arguments.variables.search).toContain('created_at:>="2026-09-08T07:00:00Z"');
  expect(body.arguments.variables.search).not.toContain('status:any');
});
test('outer Hydra success does not hide a failed provider', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(route))
    .mockResolvedValueOnce(response({...page(), result: {successful: false, error: 'revoked'}}));
  await expect(readAuditOrders({since: '2026-09-08', env, fetchImpl})).rejects.toThrow('provider failed');
});
test('refuses ambiguous routing', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(response({ok: true, decision: {requiresClarification: true}}));
  await expect(readAuditOrders({since: '2026-09-08', env, fetchImpl})).rejects.toThrow('verify');
});
test('refuses nonadvancing pagination instead of reporting partial success', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(route)).mockResolvedValue(response(page(true, 'same')));
  await expect(readAuditOrders({since: '2026-09-08', env, fetchImpl})).rejects.toThrow('pagination');
});
test('an unsuccessful read never produces a clean order report', async () => {
  const report = jest.fn();
  await expect(runShippingAudit({readOrders: async () => {throw new Error('offline');}, report})).rejects.toThrow('offline');
  expect(report).not.toHaveBeenCalled();
});
test('search parser warnings fail rather than silently broadening the audit', async () => {
  const result = page();
  result.result.data.extensions = {search:[{warnings:[{code:'invalid_field'}]}]};
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(route)).mockResolvedValueOnce(response(result));
  await expect(readAuditOrders({since:'2026-09-07',until:'2026-09-08',env,fetchImpl})).rejects.toThrow('search filter');
});
test('out-of-window orders are never included in the totals', async () => {
  const result = page(); result.result.data.data.orders.nodes = [{createdAt:'2026-09-09T00:00:00Z'}];
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(route)).mockResolvedValueOnce(response(result));
  await expect(readAuditOrders({since:'2026-09-07',until:'2026-09-08',env,fetchImpl})).rejects.toThrow('outside');
});
