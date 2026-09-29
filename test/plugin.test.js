// Schemastery's CommonJS entry requires an ESM dependency. Use Node's native
// loader (as Harness does) because Jest 29 cannot perform that interop itself.
jest.mock('@deepseek-ai/schemastery', () => {
  const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
  return nativeRequire('@deepseek-ai/schemastery');
});

const plugin = require('..');
const WebSearchPlugin = require('../src/index');
const axios = require('axios');

describe('DeepSeek Harness provider integration', () => {
  let search;
  let available;
  let ctx;
  let disposers;

  beforeEach(() => {
    search = jest.spyOn(WebSearchPlugin.prototype, 'search');
    available = jest.spyOn(WebSearchPlugin.prototype, 'isAvailable').mockReturnValue(true);
    disposers = [];
    ctx = {
      web: { registerSearchProvider: jest.fn(() => jest.fn()) },
      effect: callback => { disposers.push(callback()); },
      inject: jest.fn(),
    };
  });

  afterEach(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    jest.restoreAllMocks();
  });

  async function provider(config = {}) {
    await plugin.apply(ctx, { minIntervalMs: 0, ...config });
    expect(ctx.web.registerSearchProvider).toHaveBeenCalledTimes(1);
    return ctx.web.registerSearchProvider.mock.calls[0][0];
  }

  test('the package root exposes a Cordis plugin and the standalone client', () => {
    expect(plugin.name).toBe('web-search');
    expect(plugin.inject).toContain('web');
    expect(plugin.apply).toEqual(expect.any(Function));
    expect(plugin.PROVIDER_ID).toBe('local-web-search');
    expect(plugin.WebSearchPlugin).toBe(WebSearchPlugin);
    expect(plugin.create).toEqual(expect.any(Function));
  });

  test('registers the configured provider and reports client availability', async () => {
    const registered = await provider();
    expect(registered.id).toBe(plugin.PROVIDER_ID);
    expect(registered.available()).toBe(true);
    available.mockReturnValue(false);
    expect(registered.available()).toBe(false);
  });

  test('maps sources and truncation into the native web API and forwards the cap and signal', async () => {
    search.mockResolvedValue({
      engine: 'duckduckgo',
      results: [{ url: 'https://example.com', title: 'Example', snippet: 'An example.', engine: 'duckduckgo' }],
      count: 1,
      truncated: true
    });
    const registered = await provider();
    const signal = new AbortController().signal;
    const result = await registered.search({ query: 'example', maxResults: 3 }, signal);
    expect(search).toHaveBeenCalledWith('example', expect.objectContaining({ num: 3, signal: expect.any(AbortSignal) }));
    expect(result.sources).toEqual([{ url: 'https://example.com', title: 'Example', snippet: 'An example.' }]);
    expect(result.truncated).toBe(true);
    expect(result.content).toMatch(/Instant Answers/i);
  });

  test('keeps the DDG limitation visible even when no Instant Answer exists', async () => {
    search.mockResolvedValue({ engine: 'duckduckgo', results: [], count: 0, truncated: false });
    const registered = await provider();
    const result = await registered.search({ query: 'a query without a topic' });
    expect(result.sources).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.content).toMatch(/Instant Answers/i);
  });

  test('does not label another provider as DuckDuckGo', async () => {
    search.mockResolvedValue({ engine: 'google', results: [], count: 0, truncated: false });
    const registered = await provider();
    const result = await registered.search({ query: 'example', maxResults: 4 });
    expect(result.content || '').not.toMatch(/DuckDuckGo/);
  });

  test('preserves provider failure and cancellation instead of returning fake empty results', async () => {
    const registered = await provider();
    const failure = new Error('Provider unavailable');
    search.mockRejectedValueOnce(failure);
    await expect(registered.search({ query: 'example' })).rejects.toBe(failure);

    const controller = new AbortController();
    const cancellation = new DOMException('Cancelled', 'AbortError');
    controller.abort(cancellation);
    search.mockRejectedValueOnce(cancellation);
    await expect(registered.search({ query: 'example' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError', code: 'ERR_CANCELED' });
  });

  test('caps model results and retains consumed requests after live limits change', async () => {
    search.mockResolvedValue({ engine: 'duckduckgo', results: [], truncated: false });
    let cap = 3;
    let budget = 2;
    const registered = await provider({
      maxResults: { get: () => cap }, maxRequestsPerMinute: { get: () => budget },
    });
    await registered.search({ query: 'first', maxResults: 20 });
    expect(search).toHaveBeenLastCalledWith('first', expect.objectContaining({ num: 3 }));
    cap = 1;
    await registered.search({ query: 'second' });
    expect(search).toHaveBeenLastCalledWith('second', expect.objectContaining({ num: 1 }));
    budget = 1;
    await expect(registered.search({ query: 'third' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(search).toHaveBeenCalledTimes(2);
  });

  test('rejects missing credentials before consuming the shared budget', async () => {
    search.mockResolvedValue({ engine: 'brave', results: [], truncated: false });
    const registered = await provider({ defaultEngine: 'brave', maxRequestsPerMinute: 1 });
    available.mockReturnValue(false);
    await expect(registered.search({ query: 'missing' })).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
    available.mockReturnValue(true);
    await registered.search({ query: 'configured' });
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('abort and disposal cancel the in-flight transport', async () => {
    let transportSignal;
    search.mockImplementation((_query, { signal }) => new Promise((_resolve, reject) => {
      transportSignal = signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'ERR_CANCELED' })));
    }));
    const registered = await provider();
    const controller = new AbortController();
    const pending = registered.search({ query: 'cancel' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(transportSignal.aborted).toBe(true);
    const next = registered.search({ query: 'dispose' });
    for (const dispose of disposers.splice(0)) dispose?.();
    await expect(next).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  });

  test('uses live UI credentials and provider selection for Tavily and Exa without remounting', async () => {
    search.mockRestore();
    available.mockRestore();
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { results: [
      { title: 'A source', url: 'https://example.com/source', content: 'Tavily excerpt', highlights: ['Exa excerpt'] }
    ] } });
    let selectedEngine = 'tavily';
    let tavilyKey;
    let exaKey;
    const registered = await provider({
      defaultEngine: { get: () => selectedEngine },
      tavilyApiKey: { get: () => tavilyKey },
      exaApiKey: { get: () => exaKey }
    });
    expect(registered.available()).toBe(false);
    tavilyKey = 'saved-tavily-key';
    expect(registered.available()).toBe(true);
    const tavilyResult = await registered.search({ query: 'query', maxResults: 2 });
    expect(post.mock.calls[0][2].headers.Authorization).toBe('Bearer saved-tavily-key');
    expect(tavilyResult.sources[0].snippet).toBe('Tavily excerpt');

    tavilyKey = 'rotated-tavily-key';
    await registered.search({ query: 'query', maxResults: 2 });
    expect(post.mock.calls[1][2].headers.Authorization).toBe('Bearer rotated-tavily-key');

    selectedEngine = 'exa';
    expect(registered.available()).toBe(false);
    exaKey = 'saved-exa-key';
    expect(registered.available()).toBe(true);
    const exaResult = await registered.search({ query: 'query', maxResults: 2 });
    expect(post.mock.calls[2][2].headers['x-api-key']).toBe('saved-exa-key');
    expect(exaResult.sources[0].snippet).toBe('Exa excerpt');
    exaKey = '';
    expect(registered.available()).toBe(false);
    expect(ctx.web.registerSearchProvider).toHaveBeenCalledTimes(1);
  });
});
