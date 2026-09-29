const axios = require('axios');
const { inspect } = require('node:util');
const Client = require('../src/index');
jest.mock('axios');
const create = (config = {}, filters) => new Client({ defaultEngine: 'searxng', engines: { searxng: { instanceUrl: 'http://localhost:8080', ...config } }, filters });
beforeEach(() => jest.resetAllMocks());

test('does not add setup to the default provider', async () => {
  expect(new Client().isAvailable()).toBe(true);
  expect(new Client().isAvailable('searxng')).toBe(false);
  await expect(new Client({ defaultEngine: 'searxng' }).search('q')).rejects.toMatchObject({ code: 'MISSING_INSTANCE' });
});
test.each(['http://localhost:8080', 'http://127.0.0.1', 'http://[::1]', 'http://[fd12::1]', 'http://192.168.1.5', 'http://172.16.0.2', 'http://10.0.0.1', 'http://searxng:8080', 'http://host.docker.internal:8080', 'https://search.example.com/base/'])('accepts configured instance %s', instanceUrl => {
  expect(create({ instanceUrl }).isAvailable()).toBe(true);
});
test.each(['http://public.example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://user:password@localhost', 'https://example.com/?key=secret', 'https://example.com/#x', 'file:///tmp/search', 'https://example.com/%2fsearch'])('rejects unsafe or ambiguous instance %s', instanceUrl => {
  expect(() => create({ instanceUrl })).toThrow();
});
test.each([['none', {}, undefined], ['bearer', { token: 'private-token' }, 'Bearer private-token'], ['basic', { username: 'user', password: ' p:a:ss ' }, `Basic ${Buffer.from('user: p:a:ss ').toString('base64')}`]])('searches base paths using %s authentication without redirects', async (auth, credentials, expected) => {
  axios.get.mockResolvedValue({ data: { results: [{ title: 'Result', url: 'https://example.org', content: 'Excerpt' }] } });
  const signal = new AbortController().signal;
  const result = await create({ instanceUrl: 'https://search.example.com/nested/search/', auth, ...credentials }).search('private query', { signal });
  expect(result.results[0]).toMatchObject({ title: 'Result', snippet: 'Excerpt', engine: 'searxng' });
  const [url, request] = axios.get.mock.calls[0];
  expect(url).toBe('https://search.example.com/nested/search');
  expect(request.params).toEqual({ q: 'private query', format: 'json', pageno: 1, categories: 'general' });
  expect(request.headers.Authorization).toBe(expected);
  expect(request).toMatchObject({ signal, maxRedirects: 0, timeout: 15000, maxContentLength: 2 * 1024 * 1024 });
});
test.each([{ auth: 'bearer' }, { auth: 'basic', username: 'user' }])('requires configured authentication %p', async config => {
  await expect(create(config).search('q')).rejects.toMatchObject({ code: 'MISSING_INSTANCE' });
  expect(axios.get).not.toHaveBeenCalled();
});
test.each([{ auth: 'bearer', token: 'key\r\nheader' }, { auth: 'basic', username: 'u:s', password: 'p' }, { auth: 'cookies' }])('rejects invalid authentication %p', config => {
  expect(() => create(config)).toThrow();
});
test('keeps partial results and applies filters, without exposing upstream error text', async () => {
  axios.get.mockResolvedValue({ data: { results: [
    { title: 'Good', url: 'https://example.com/a', content: 'x' }, { title: 'Bad', url: 'https://other.test' }],
    unresponsive_engines: [['engine', 'private-token error']] } });
  const result = await create({}, { allowedDomains: 'example.com', dateRange: 'day' }).search('q');
  expect(result).toMatchObject({ count: 1, filteredCount: 1, partialFailureCount: 1, limitedDateFilter: true });
  expect(axios.get.mock.calls[0][1].params.time_range).toBe('day');
  expect(JSON.stringify(result)).not.toContain('private-token');
});
test('distinguishes empty search from empty results with upstream failures', async () => {
  axios.get.mockResolvedValueOnce({ data: { results: [] } }).mockResolvedValueOnce({ data: { results: [], unresponsive_engines: [['google', 'CAPTCHA']] } });
  expect((await create().search('q')).count).toBe(0);
  await expect(create().search('q')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
});
test.each(['<html>login</html>', {}, { results: null }, { results: [], unresponsive_engines: 'bad' }])('rejects non-search responses %p', async data => {
  axios.get.mockResolvedValue({ data });
  await expect(create().search('q')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test.each([[401,'INSTANCE_ACCESS_DENIED'],[403,'INSTANCE_ACCESS_DENIED'],[429,'RATE_LIMITED'],[500,'PROVIDER_ERROR']])('classifies HTTP %i and drops remote error content', async (status, code) => {
  axios.get.mockRejectedValue({ response: { status, data: { error: 'private-token private-user private-query' } } });
  const pending = create({ auth: 'bearer', token: 'private-token' }).search('private-query');
  await expect(pending).rejects.toMatchObject({ code, status });
  await pending.catch(error => expect(inspect(error, { depth: null })).not.toMatch(/private-token|private-user|private-query/));
});
test('cancellation reaches transport and timeout is classified', async () => {
  axios.get.mockRejectedValueOnce({ code: 'ERR_CANCELED' }).mockRejectedValueOnce({ code: 'ETIMEDOUT' });
  await expect(create().search('q')).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await expect(create().search('q')).rejects.toMatchObject({ code: 'TIMEOUT' });
});
