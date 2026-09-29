const WebSearchPlugin = require('../src/index');
const axios = require('axios');
const { inspect } = require('node:util');

jest.mock('axios');

const googleConfig = { apiKey: 'google-secret', searchEngineId: 'test-cx' };
const braveConfig = { apiKey: 'brave-secret' };
const tavilyConfig = { apiKey: 'tavily-secret' };
const exaConfig = { apiKey: 'exa-secret' };

function client(config = {}) {
  return new WebSearchPlugin({ engines: { google: googleConfig, brave: braveConfig, tavily: tavilyConfig, exa: exaConfig }, ...config });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('configuration and availability', () => {
  test('defaults to usable DuckDuckGo without credentials and exposes only supported providers', () => {
    const plugin = new WebSearchPlugin();
    expect(plugin.config.defaultEngine).toBe('duckduckgo');
    expect(plugin.isAvailable()).toBe(true);
    expect(plugin.isAvailable('brave')).toBe(false);
    expect(plugin.isAvailable('tavily')).toBe(false);
    expect(plugin.isAvailable('exa')).toBe(false);
    expect(plugin.isAvailable('google')).toBe(false);
    expect(plugin.isAvailable('bing')).toBe(false);
    expect(plugin.getSupportedEngines()).toEqual(['duckduckgo', 'brave', 'tavily', 'exa', 'searxng', 'google']);
  });

  test('merges per-provider credentials without losing endpoint defaults or other providers', () => {
    const plugin = client({ defaultEngine: 'google', engines: { google: googleConfig } });
    expect(plugin.config.engines.google.baseUrl).toBe('https://www.googleapis.com/customsearch/v1');
    expect(plugin.isAvailable()).toBe(true);
    expect(plugin.isAvailable('duckduckgo')).toBe(true);
    expect(plugin.isAvailable('brave')).toBe(false);
  });

  test('does not load credentials or engine selection from environment variables', () => {
    const previous = { ...process.env };
    try {
      process.env.WEB_SEARCH_ENGINE = 'google';
      process.env.BRAVE_SEARCH_API_KEY = 'environment-brave-key';
      process.env.TAVILY_API_KEY = 'environment-tavily-key';
      process.env.EXA_API_KEY = 'environment-exa-key';
      process.env.GOOGLE_SEARCH_API_KEY = 'environment-google-key';
      process.env.GOOGLE_SEARCH_ENGINE_ID = 'environment-cx';
      const plugin = new WebSearchPlugin();
      expect(plugin.config.defaultEngine).toBe('duckduckgo');
      expect(plugin.isAvailable('google')).toBe(false);
      expect(plugin.isAvailable('brave')).toBe(false);
      expect(plugin.isAvailable('tavily')).toBe(false);
      expect(plugin.isAvailable('exa')).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  test.each([
    null, [], { engines: null }, { engines: [] }, { engines: { google: null } },
    { engines: { unsupported: {} } }, { defaultEngine: 'unsupported' },
    { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: '15000' }
  ])('rejects invalid configuration %p', config => {
    expect(() => new WebSearchPlugin(config)).toThrow();
  });

  test.each(['http://api.example.com/search', 'https://user:secret@example.com/', 'https://example.com/?key=secret', 'https://example.com/#x', 'not-a-url'])('rejects unsafe endpoint %s', baseUrl => {
    expect(() => client({ engines: { brave: { baseUrl } } })).toThrow('HTTPS URL');
  });

  test('rejects retired Bing selection before any network call', async () => {
    expect(() => new WebSearchPlugin({ defaultEngine: 'bing' })).toThrow('retired on August 11, 2025');
    await expect(client().search('query', { engine: 'bing' })).rejects.toMatchObject({ code: 'ENGINE_RETIRED' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test.each([
    ['brave', {}], ['brave', { apiKey: '  ' }], ['google', { apiKey: 'key' }],
    ['google', { searchEngineId: 'cx' }], ['tavily', {}], ['exa', {}],
    ['tavily', { apiKey: '  ' }], ['exa', { apiKey: '  ' }]
  ])('requires complete %s credentials before network calls', async (engine, config) => {
    const plugin = new WebSearchPlugin({ engines: { [engine]: config } });
    await expect(plugin.search('query', { engine })).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS', engine });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('authenticated POST search providers', () => {
  test('Tavily uses explicit basic search, Bearer auth, and source content', async () => {
    const signal = new AbortController().signal;
    axios.post.mockResolvedValue({ data: { query: 'test query', results: [
      { title: 'Tavily result', url: 'https://example.com/tavily', content: 'Source excerpt', score: 0.9 }
    ] } });
    const result = await client().search(' test query ', { engine: 'tavily', num: 3, signal });
    expect(axios.post).toHaveBeenCalledWith('https://api.tavily.com/search', {
      query: 'test query', max_results: 3, search_depth: 'basic', auto_parameters: false,
      include_answer: false, include_raw_content: false, include_images: false
    }, {
      headers: { Accept: 'application/json', Authorization: 'Bearer tavily-secret', 'Content-Type': 'application/json' },
      timeout: 15000, signal, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, responseType: 'json'
    });
    expect(result).toEqual({ query: 'test query', engine: 'tavily', count: 1, truncated: false,
      results: [{ title: 'Tavily result', url: 'https://example.com/tavily', snippet: 'Source excerpt', engine: 'tavily' }] });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('Exa requests highlights without full text and combines returned highlights', async () => {
    const signal = new AbortController().signal;
    axios.post.mockResolvedValue({ data: { requestId: 'request-1', results: [
      { title: 'Exa result', url: 'https://example.com/exa', highlights: ['First excerpt', 'Second excerpt'], text: 'Should not be returned' },
      { title: 'No extract available', url: 'https://example.com/no-extract' }
    ] } });
    const result = await client().search('test query', { engine: 'exa', num: 2, signal, timeoutMs: 5000 });
    expect(axios.post).toHaveBeenCalledWith('https://api.exa.ai/search', {
      query: 'test query', numResults: 2, type: 'auto', contents: { highlights: true, text: false }
    }, {
      headers: { Accept: 'application/json', 'x-api-key': 'exa-secret', 'Content-Type': 'application/json' },
      timeout: 5000, signal, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, responseType: 'json'
    });
    expect(result.results).toEqual([
      { title: 'Exa result', url: 'https://example.com/exa', snippet: 'First excerpt\nSecond excerpt', engine: 'exa' },
      { title: 'No extract available', url: 'https://example.com/no-extract', snippet: '', engine: 'exa' }
    ]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test.each(['tavily', 'exa'])('accepts an empty %s result set', async engine => {
    axios.post.mockResolvedValue({ data: { results: [] } });
    await expect(client().search('test query', { engine })).resolves.toMatchObject({ count: 0, results: [], truncated: false });
  });

  test.each([
    ['tavily', {}], ['tavily', { results: null }], ['tavily', { results: {} }], ['tavily', '<html>error</html>'],
    ['exa', {}], ['exa', { results: null }], ['exa', { results: {} }], ['exa', '<html>error</html>'],
    ['exa', { results: [{ title: 'Broken', url: 'https://example.com/', highlights: 'not an array' }] }]
  ])('rejects malformed %s results %p', async (engine, data) => {
    axios.post.mockResolvedValue({ data });
    await expect(client().search('test query', { engine })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', engine });
  });

  test.each(['tavily', 'exa'])('applies URL filtering, text bounds, and result caps to %s', async engine => {
    axios.post.mockResolvedValue({ data: { results: [
      { title: 'Bad', url: 'javascript:alert(1)', content: 'bad', highlights: ['bad'] },
      { title: 'a'.repeat(500), url: 'https://example.com/valid', content: 'b'.repeat(3000), highlights: ['b'.repeat(3000)] },
      { title: 'Duplicate', url: 'https://example.com/valid', content: 'duplicate', highlights: ['duplicate'] },
      { title: 'Extra', url: 'https://example.com/extra', content: 'extra', highlights: ['extra'] }
    ] } });
    const result = await client().search('test query', { engine, num: 1 });
    expect(result.count).toBe(1);
    expect(result.results[0].title).toHaveLength(300);
    expect(result.results[0].snippet).toHaveLength(2000);
    expect(result.results[0].url).toBe('https://example.com/valid');
    expect(result.truncated).toBe(true);
  });

  test.each([
    ['tavily', 401, { detail: { error: 'Invalid tavily-secret' } }, 'INVALID_CREDENTIALS'],
    ['tavily', 429, { detail: { error: 'Rate limited tavily-secret' } }, 'RATE_LIMITED'],
    ['tavily', 432, { detail: { error: 'Usage limit tavily-secret' } }, 'QUOTA_EXCEEDED'],
    ['tavily', 433, { detail: { error: 'Pay-as-you-go limit tavily-secret' } }, 'QUOTA_EXCEEDED'],
    ['tavily', 422, { detail: [{ msg: 'Validation failed tavily-secret', input: 'secret request data' }] }, 'PROVIDER_ERROR'],
    ['exa', 401, { error: 'Invalid exa-secret', tag: 'INVALID_API_KEY' }, 'INVALID_CREDENTIALS'],
    ['exa', 402, { error: 'No credits exa-secret', tag: 'INSUFFICIENT_CREDITS' }, 'QUOTA_EXCEEDED'],
    ['exa', 429, { error: 'Rate limited exa-secret', tag: 'RATE_LIMIT_EXCEEDED' }, 'RATE_LIMITED']
  ])('classifies %s HTTP %i errors while redacting credentials', async (engine, status, data, code) => {
    axios.post.mockRejectedValue({ response: { status, data }, config: { headers: { Authorization: `${engine}-secret` } } });
    const promise = client().search('test query', { engine });
    await expect(promise).rejects.toMatchObject({ code, status, engine });
    await promise.catch(error => {
      expect(error.message).toContain('[REDACTED]');
      expect(inspect(error, { depth: null })).not.toContain(`${engine}-secret`);
      expect(inspect(error, { depth: null })).not.toContain('secret request data');
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('recognizes Tavily detail error envelopes even if sent with HTTP 200', async () => {
    axios.post.mockResolvedValue({ data: { detail: { error: 'API unavailable' } } });
    await expect(client().search('query', { engine: 'tavily' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  test.each(['tavily', 'exa'])('keeps cancellation safe for %s POST requests', async engine => {
    axios.post.mockRejectedValue({ code: 'ERR_CANCELED', config: { headers: { Authorization: `${engine}-secret` } } });
    const promise = client().search('query', { engine });
    await expect(promise).rejects.toMatchObject({ code: 'ERR_CANCELED', name: 'CanceledError', __CANCEL__: true });
    await promise.catch(error => expect(inspect(error, { depth: null })).not.toContain(`${engine}-secret`));
  });
});

describe('input validation', () => {
  test.each([undefined, null, '', ' \n\t ', 42, {}, []])('rejects invalid query %p', async query => {
    await expect(client().search(query)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test.each([0, -1, 21, 1.5, '5', NaN, Infinity])('rejects invalid result count %p', async num => {
    await expect(client().search('query', { num })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test.each([null, [], 'options'])('rejects invalid options %p', async options => {
    await expect(client().search('query', options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('enforces Brave documented query size before calling API', async () => {
    await expect(client().search('x'.repeat(601), { engine: 'brave' })).rejects.toThrow('600 characters');
    await expect(client().search(Array(76).fill('word').join(' '), { engine: 'brave' })).rejects.toThrow('75 words');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test.each([{ signal: {} }, { signal: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }])('rejects invalid request options %p', async options => {
    await expect(client().search('query', options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('provider requests and parsing', () => {
  test('uses DDG Instant Answer abstracts, official links, and deeply nested topics in order', async () => {
    axios.get.mockResolvedValue({ data: {
      Heading: 'A subject', AbstractURL: 'https://example.com/subject', AbstractText: 'Main answer',
      Results: [{ FirstURL: 'https://example.com/official', Text: 'Official website' }],
      RelatedTopics: [null, { Topics: [null, { Topics: [{ FirstURL: 'https://example.com/deep', Text: 'Nested answer' }] }] },
        { FirstURL: 'https://example.com/last', Text: 'Last topic' }]
    } });
    const result = await client().search('  a subject  ');
    expect(result).toEqual({
      query: 'a subject', engine: 'duckduckgo', count: 4, truncated: false,
      results: [
        { title: 'A subject', url: 'https://example.com/subject', snippet: 'Main answer', engine: 'duckduckgo' },
        { title: 'Official website', url: 'https://example.com/official', snippet: 'Official website', engine: 'duckduckgo' },
        { title: 'Nested answer', url: 'https://example.com/deep', snippet: 'Nested answer', engine: 'duckduckgo' },
        { title: 'Last topic', url: 'https://example.com/last', snippet: 'Last topic', engine: 'duckduckgo' }
      ]
    });
    expect(axios.get).toHaveBeenCalledWith('https://api.duckduckgo.com/', expect.objectContaining({
      params: { q: 'a subject', format: 'json', no_html: 1, no_redirect: 1 },
      timeout: 15000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, responseType: 'json'
    }));
  });

  test('Brave sends header credentials and maps ranked web results', async () => {
    axios.get.mockResolvedValue({ data: { type: 'search', web: { results: [
      { title: 'Current news', url: 'https://example.com/news', description: 'A useful snippet' }
    ] } } });
    const result = await client().search('latest news', { engine: 'brave', num: 5 });
    expect(result.results).toEqual([{ title: 'Current news', url: 'https://example.com/news', snippet: 'A useful snippet', engine: 'brave' }]);
    expect(axios.get).toHaveBeenCalledWith('https://api.search.brave.com/res/v1/web/search', expect.objectContaining({
      params: { q: 'latest news', count: 5, text_decorations: false, result_filter: 'web' },
      headers: { Accept: 'application/json', 'X-Subscription-Token': 'brave-secret' }, maxRedirects: 0
    }));
  });

  test('Google caps requests at ten and tells callers when requested results were truncated', async () => {
    axios.get.mockResolvedValue({ data: { kind: 'customsearch#search', items: [
      { title: 'Page', link: 'https://example.com/page', snippet: 'Snippet' }
    ] } });
    const result = await client().search('a query', { engine: 'google', num: 20 });
    expect(result).toMatchObject({ count: 1, truncated: true, results: [{ engine: 'google', snippet: 'Snippet' }] });
    expect(axios.get).toHaveBeenCalledWith('https://www.googleapis.com/customsearch/v1', expect.objectContaining({
      params: { key: 'google-secret', cx: 'test-cx', q: 'a query', num: 10 }
    }));
  });

  test.each([
    ['google', { kind: 'customsearch#search', searchInformation: { totalResults: '0' } }],
    ['brave', { type: 'search' }],
    ['brave', { type: 'search', web: null }],
    ['duckduckgo', { AbstractText: '', Results: [], RelatedTopics: [] }]
  ])('accepts genuine zero-result %s responses', async (engine, data) => {
    axios.get.mockResolvedValue({ data });
    await expect(client().search('unknown query', { engine })).resolves.toMatchObject({ count: 0, results: [], truncated: false });
  });

  test.each([
    ['google', {}], ['google', { items: {} }], ['google', '<html>Unavailable</html>'],
    ['brave', { web: { results: null } }], ['brave', { type: 'search', web: [] }],
    ['duckduckgo', null], ['duckduckgo', []], ['duckduckgo', { status: 'error' }],
    ['duckduckgo', { RelatedTopics: {} }], ['duckduckgo', { Results: null }],
    ['duckduckgo', { RelatedTopics: [{ Topics: 'broken' }] }]
  ])('rejects malformed %s payload %p instead of inventing empty results', async (engine, data) => {
    axios.get.mockResolvedValue({ data });
    await expect(client().search('query', { engine })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', engine });
  });

  test('filters unsafe and duplicate URLs before applying the result limit', async () => {
    axios.get.mockResolvedValue({ data: { RelatedTopics: [
      { FirstURL: 'javascript:alert(1)', Text: 'Invalid' },
      { FirstURL: 'https://user:password@example.com/', Text: 'Credential URL' },
      { FirstURL: 'https://example.com', Text: 'First' },
      { FirstURL: 'https://example.com/', Text: 'Duplicate' },
      { FirstURL: 'https://example.com/second', Text: 'Second' },
      { FirstURL: 'http://example.com/third', Text: 'Third' }
    ] } });
    const result = await client().search('query', { num: 2 });
    expect(result.results.map(item => item.title)).toEqual(['First', 'Second']);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test('bounds provider text before returning it to a model', async () => {
    axios.get.mockResolvedValue({ data: { items: [
      { title: 'a'.repeat(400), link: 'https://example.com/', snippet: '\u0000' + 'b'.repeat(2500) }
    ] } });
    const result = await client().search('query', { engine: 'google' });
    expect(result.results[0].title).toHaveLength(300);
    expect(result.results[0].snippet).toHaveLength(2000);
    expect(result.results[0].snippet).not.toContain('\u0000');
    expect(result.truncated).toBe(true);
  });

  test('defaults to eight results and supports create/query compatibility', async () => {
    axios.get.mockResolvedValue({ data: { RelatedTopics: Array.from({ length: 9 }, (_, index) => ({
      FirstURL: `https://example.com/${index}`, Text: `Topic ${index}`
    })) } });
    const plugin = await WebSearchPlugin.create();
    await expect(plugin.query('query')).resolves.toMatchObject({ count: 8, truncated: true });
  });
});

describe('timeouts, cancellation, and safe errors', () => {
  test('passes caller cancellation and configurable timeout to the HTTP request', async () => {
    const controller = new AbortController();
    axios.get.mockResolvedValue({ data: { RelatedTopics: [] } });
    const plugin = client({ timeoutMs: 1000 });
    await plugin.search('query', { signal: controller.signal });
    expect(axios.get.mock.calls[0][1]).toMatchObject({ timeout: 1000, signal: controller.signal });
    await plugin.search('query', { timeoutMs: 2000 });
    expect(axios.get.mock.calls[1][1].timeout).toBe(2000);
  });

  test('does not issue a request for an already canceled signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().search('query', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', code: 'ERR_CANCELED' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('preserves in-flight Axios cancellation semantics without retaining request credentials', async () => {
    const canceled = Object.assign(new Error('canceled'), {
      code: 'ERR_CANCELED', config: { headers: { 'X-Subscription-Token': 'brave-secret' } }
    });
    axios.get.mockRejectedValue(canceled);
    const promise = client().search('query', { engine: 'brave' });
    await expect(promise).rejects.toMatchObject({ code: 'ERR_CANCELED', name: 'CanceledError', __CANCEL__: true });
    await promise.catch(error => {
      expect(error).not.toBe(canceled);
      expect(inspect(error, { depth: null })).not.toContain('brave-secret');
    });
  });

  test('preserves HTTP status and a sanitized cause without retaining credentials', async () => {
    const providerError = Object.assign(new Error('request leaked google-secret'), { response: {
      status: 403,
      data: { error: { message: 'Invalid google-secret for test-cx' } }
    } });
    axios.get.mockRejectedValue(providerError);
    let caught;
    try { await client().search('query', { engine: 'google' }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 403, engine: 'google', cause: { code: 'INVALID_CREDENTIALS', status: 403 } });
    expect(caught.cause).not.toBe(providerError);
    expect(caught.message).toContain('HTTP 403');
    expect(caught.message).toContain('[REDACTED]');
    expect(caught.message).not.toContain('google-secret');
    expect(caught.message).not.toContain('test-cx');
    expect(JSON.stringify(caught)).not.toContain('google-secret');
    expect(inspect(caught, { depth: null })).not.toContain('google-secret');
    expect(inspect(caught, { depth: null })).not.toContain('test-cx');
  });

  test('redacts encoded credentials before bounding provider messages', async () => {
    const apiKey = 'secret/key+value';
    axios.get.mockRejectedValue({ response: { status: 429, data: { error: {
      detail: `${encodeURIComponent(apiKey)}: ${'x'.repeat(2000)}`
    } } } });
    const promise = client({ engines: { brave: { apiKey } } }).search('query', { engine: 'brave' });
    await expect(promise).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    await expect(promise).rejects.toThrow('[REDACTED]');
    await promise.catch(error => {
      expect(error.message).not.toContain(encodeURIComponent(apiKey));
      expect(error.message.length).toBeLessThan(600);
    });
  });

  test.each(['ECONNABORTED', 'ETIMEDOUT'])('normalizes timeout %s without exposing request details', async code => {
    axios.get.mockRejectedValue(Object.assign(new Error('https://example.com?key=google-secret'), { code }));
    await expect(client().search('query')).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('increase the timeout') });
  });

  test('does not expose raw network exception messages to the model', async () => {
    axios.get.mockRejectedValue(new Error('https://example.com?key=google-secret'));
    await expect(client().search('query')).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('Check the network connection') });
  });

  test('explains response size failures without exposing the original request', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('maxContentLength size of 2097152 exceeded'), {
      code: 'ERR_BAD_RESPONSE', config: { headers: { 'X-Subscription-Token': 'brave-secret' } }
    }));
    const promise = client().search('query', { engine: 'brave' });
    await expect(promise).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', message: 'brave search response exceeded the 2 MiB limit' });
    await promise.catch(error => expect(inspect(error, { depth: null })).not.toContain('brave-secret'));
  });

  test('rejects provider errors delivered with HTTP 200', async () => {
    axios.get.mockResolvedValue({ data: { error: { message: 'Quota exceeded' } } });
    await expect(client().search('query', { engine: 'google' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  test.each([
    ['dailyLimitExceeded', 'QUOTA_EXCEEDED'],
    ['quotaExceeded', 'QUOTA_EXCEEDED'],
    ['userRateLimitExceeded', 'RATE_LIMITED'],
    ['rateLimitExceeded', 'RATE_LIMITED'],
    ['accessNotConfigured', 'INVALID_CREDENTIALS']
  ])('distinguishes Google HTTP 403 reason %s from invalid credentials', async (reason, code) => {
    axios.get.mockRejectedValue({ response: { status: 403, data: {
      error: { code: 403, message: 'Request rejected', errors: [{ reason }] }
    } } });
    await expect(client().search('query', { engine: 'google' })).rejects.toMatchObject({ code, status: 403 });
  });

  test.each([
    ['SUBSCRIPTION_TOKEN_INVALID', 422, 'INVALID_CREDENTIALS'],
    ['QUOTA_LIMITED', 429, 'QUOTA_EXCEEDED'],
    ['RATE_LIMITED', 429, 'RATE_LIMITED']
  ])('recognizes Brave reason %s even when HTTP status alone is ambiguous', async (providerCode, status, code) => {
    axios.get.mockRejectedValue({ response: { status, data: { error: { code: providerCode, detail: 'Request rejected' } } } });
    await expect(client().search('query', { engine: 'brave' })).rejects.toMatchObject({ code, status });
  });

  test.each([
    [403, [], 'QUOTA_EXCEEDED'],
    [403, [{ reason: 'RATE_LIMIT_EXCEEDED' }], 'RATE_LIMITED'],
    [429, [], 'RATE_LIMITED']
  ])('handles Google RESOURCE_EXHAUSTED without replacing more specific rate information', async (status, details, code) => {
    axios.get.mockRejectedValue({ response: { status, data: {
      error: { status: 'RESOURCE_EXHAUSTED', details }
    } } });
    await expect(client().search('query', { engine: 'google' })).rejects.toMatchObject({ code, status });
  });

  test('does not suggest entering an API key when the account-free endpoint blocks a request', async () => {
    axios.get.mockRejectedValue({ response: { status: 403, data: 'Forbidden' } });
    const promise = client().search('query');
    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 403 });
    await promise.catch(error => expect(error.message).not.toMatch(/API key/));
  });

  test.each([
    ['3', 3000], ['0.5', 500], ['0', 0],
    ['invalid', undefined], ['-1', undefined], ['Infinity', undefined],
    ['999999999999999999999999', undefined]
  ])('parses Retry-After %s without retaining unsafe header values', async (header, expected) => {
    axios.get.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': header } } });
    const error = await client().search('query', { engine: 'brave' }).catch(value => value);
    expect(error.retryAfterMs).toBe(expected);
    expect(error.code).toBe('RATE_LIMITED');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('supports HTTP-date Retry-After and AxiosHeaders without leaking response headers', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 29, 12));
    try {
      axios.get.mockRejectedValue({ response: {
        status: 503,
        headers: { get: name => name === 'retry-after' ? 'Tue, 29 Sep 2026 12:00:05 GMT' : 'brave-secret' }
      } });
      const error = await client().search('query', { engine: 'brave' }).catch(value => value);
      expect(error).toMatchObject({ code: 'PROVIDER_ERROR', retryAfterMs: 5000, status: 503 });
      expect(inspect(error, { depth: null })).not.toContain('brave-secret');
    } finally {
      now.mockRestore();
    }
  });

  test('classifies structured error envelopes and preserves Retry-After even with HTTP 200', async () => {
    axios.post.mockResolvedValue({ status: 200, headers: { 'retry-after': '2' }, data: {
      error: 'Temporarily limited', tag: 'RATE_LIMIT_EXCEEDED'
    } });
    await expect(client().search('query', { engine: 'exa' })).rejects.toMatchObject({
      code: 'RATE_LIMITED', retryAfterMs: 2000
    });
  });
});
