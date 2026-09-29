const axios = require('axios');
const Client = require('../src/index');
const { normalizeDomains, allowsUrl, normalizeFilters } = require('../src/filters');
jest.mock('axios');
beforeEach(() => jest.resetAllMocks());

test('normalizes case, IDNs, trailing dots and duplicates', () => {
  expect(normalizeDomains('EXAMPLE.com., bücher.de\nexample.com')).toEqual(['example.com', 'xn--bcher-kva.de']);
});
test.each(['https://example.com', '*.example.com', 'user@example.com', 'example.com/path', 'x:80', '-bad.com', 'a..com', 'x%2ecom', 'x?y', 'x#y'])('rejects ambiguous domain %s', value => {
  expect(() => normalizeDomains(value)).toThrow();
});
test('bounds lists and rejects unknown filters', () => {
  expect(() => normalizeDomains(Array(101).fill('example.com'))).toThrow();
  expect(() => normalizeFilters({ dateRange: 'yesterday' })).toThrow();
  expect(() => normalizeFilters({ typo: [] })).toThrow();
});
test('enforces hostname boundaries, subdomains and block precedence', () => {
  const filters = normalizeFilters({ allowedDomains: 'example.com, bücher.de', blockedDomains: 'ads.example.com' });
  expect(allowsUrl('https://news.example.com./page', filters)).toBe(true);
  expect(allowsUrl('https://notexample.com', filters)).toBe(false);
  expect(allowsUrl('https://example.com.evil.test', filters)).toBe(false);
  expect(allowsUrl('https://x.ads.example.com', filters)).toBe(false);
  expect(allowsUrl('https://xn--bcher-kva.de', filters)).toBe(true);
});
test('filters before truncation and counts excluded unique safe candidates', async () => {
  axios.get.mockResolvedValue({ data: { RelatedTopics: [
    { FirstURL: 'https://blocked.test', Text: 'blocked' },
    { FirstURL: 'https://blocked.test', Text: 'duplicate' },
    { FirstURL: 'javascript:bad', Text: 'unsafe' },
    { FirstURL: 'https://example.com/a', Text: 'allowed' },
    { FirstURL: 'https://example.com/b', Text: 'extra' },
  ] } });
  const result = await new Client({ filters: { allowedDomains: 'example.com' } }).search('query', { num: 1 });
  expect(result).toMatchObject({ count: 1, filteredCount: 1, truncated: true });
  expect(result.results[0].url).toBe('https://example.com/a');
  expect(axios.get).toHaveBeenCalledTimes(1);
});
test.each(['duckduckgo', 'brave', 'google', 'tavily', 'exa'])('enforces domains for %s even when upstream ignores them', async engine => {
  const hit = { title: 'B', url: 'https://blocked.test', link: 'https://blocked.test', content: 'x', highlights: ['x'] };
  const data = engine === 'duckduckgo' ? { RelatedTopics: [{ FirstURL: hit.url, Text: 'x' }] }
    : engine === 'brave' ? { web: { results: [hit] } } : engine === 'google' ? { items: [hit] } : { results: [hit] };
  axios.get.mockResolvedValue({ data }); axios.post.mockResolvedValue({ data });
  const result = await new Client({ defaultEngine: engine, engines: { [engine]: { apiKey: 'key', searchEngineId: 'cx' } }, filters: { blockedDomains: 'blocked.test' } }).search('q');
  expect(result).toMatchObject({ count: 0, filteredCount: 1 });
});
test.each([['duckduckgo','day'], ['searxng','week']])('rejects unsupported %s date range before network', async (engine, dateRange) => {
  await expect(new Client({ defaultEngine: engine, filters: { dateRange } }).search('q')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILTER' });
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});
test.each(['brave','google','tavily','exa'])('maps %s date and domain filters to the documented request', async engine => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T12:00:00Z'));
  try {
    axios.get.mockResolvedValue({ data: engine === 'brave' ? { web: { results: [] } } : { items: [] } });
    axios.post.mockResolvedValue({ data: { results: [] } });
    await new Client({ defaultEngine: engine, engines: { [engine]: { apiKey: 'key', searchEngineId: 'cx' } },
      filters: { dateRange: 'week', allowedDomains: 'example.com', blockedDomains: 'ads.example.com' } }).search('q');
    if (engine === 'brave' || engine === 'google') {
      expect(axios.get.mock.calls[0][1].params).toMatchObject({ q: 'q site:example.com -site:ads.example.com',
        ...(engine === 'brave' ? { freshness: 'pw' } : { dateRestrict: 'w1' }) });
    } else if (engine === 'tavily') expect(axios.post.mock.calls[0][1]).toMatchObject({ time_range: 'week', filter_by_published_date: true,
      include_domains: ['example.com'], exclude_domains: ['ads.example.com'], include_domains_mode: 'restrict', auto_parameters: false });
    else expect(axios.post.mock.calls[0][1]).toMatchObject({ startPublishedDate: '2026-09-22T12:00:00.000Z', endPublishedDate: '2026-09-29T12:00:00.000Z', includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] });
  } finally { now.mockRestore(); }
});
test('includes generated site operators in Brave query limit validation', async () => {
  const client = new Client({ defaultEngine: 'brave', engines: { brave: { apiKey: 'key' } }, filters: { allowedDomains: 'example.com' } });
  await expect(client.search('a'.repeat(590))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(axios.get).not.toHaveBeenCalled();
});
