const { CHANNEL, createDiagnostics } = require('../src/diagnostics');

describe('saved-configuration search diagnostics', () => {
  let settings;
  let executeSearch;
  let handler;
  let revision;
  beforeEach(() => {
    revision = 7;
    settings = { describe: jest.fn(() => [{ ns: 'devbits-web-search', revision }]) };
    executeSearch = jest.fn(async (_request, _signal, beforeStart) => {
      beforeStart();
      return { engine: 'duckduckgo', results: [{ title: 'Example', url: 'https://example.com', snippet: 'An example', private: 'omitted' }], truncated: false };
    });
    handler = createDiagnostics({ settings, executeSearch, notice: 'Instant Answers limitation', now: () => 1000 });
  });

  test('returns bounded sources and safe metadata using the saved revision', async () => {
    expect(CHANNEL).toBe('/devbits-web-search');
    const signal = new AbortController().signal;
    const result = await handler('test-search', { query: 'Example', revision }, signal);
    expect(result).toEqual({ ok: true, value: {
      engine: 'duckduckgo', revision: 7, elapsedMs: 0, testedAt: '1970-01-01T00:00:01.000Z',
      count: 1, truncated: false, sources: [{ title: 'Example', url: 'https://example.com', snippet: 'An example' }],
      notice: 'Instant Answers limitation',
    } });
    expect(executeSearch).toHaveBeenCalledWith({ query: 'Example', maxResults: 3 }, signal, expect.any(Function));
    expect(settings.describe).toHaveBeenCalledWith({ redactSecrets: true });
  });

  test.each([null, [], {}, { query: '' }, { query: 'x', revision: -1 },
    { query: 'x', revision: 7, apiKey: 'never accepted' }, { query: 'x'.repeat(601), revision: 7 }])(
    'rejects malformed payload without a provider call: %j', async payload => {
      expect(await handler('test-search', payload)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      expect(executeSearch).not.toHaveBeenCalled();
    }
  );

  test('rejects unknown endpoints and stale revisions before any search', async () => {
    expect(await handler('other', { query: 'x', revision })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await handler('test-search', { query: 'x', revision: 6 })).toMatchObject({ error: { code: 'SETTINGS_CONFLICT' } });
    expect(executeSearch).not.toHaveBeenCalled();
  });

  test('rejects a settings change during the search instead of reporting success', async () => {
    executeSearch.mockImplementationOnce(async () => {
      revision++;
      return { engine: 'duckduckgo', results: [], truncated: false };
    });
    expect(await handler('test-search', { query: 'x', revision })).toMatchObject({ error: { code: 'SETTINGS_CONFLICT' } });
  });

  test('checks the revision again when a queued test starts', async () => {
    executeSearch.mockImplementationOnce(async (_request, _signal, beforeStart) => {
      revision++;
      beforeStart();
      throw new Error('must not reach transport');
    });
    expect(await handler('test-search', { query: 'x', revision })).toMatchObject({ error: { code: 'SETTINGS_CONFLICT' } });
  });

  test('exposes safe error classification without messages, query, keys or request objects', async () => {
    executeSearch.mockRejectedValueOnce(Object.assign(new Error('secret-token private query'), {
      code: 'RATE_LIMITED', engine: 'brave', status: 429, retryAfterMs: 5000,
      request: { headers: { Authorization: 'secret-token' } }, cause: new Error('secret-token'),
    }));
    const result = await handler('test-search', { query: 'private query', revision });
    expect(result).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { engine: 'brave', status: 429, retryAfterMs: 5000 } } });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private query|Authorization/);
  });

  test('explains a Keenable rate limit with a fixed message that mentions the optional key', async () => {
    executeSearch.mockRejectedValueOnce(Object.assign(new Error('private detail'), { code: 'RATE_LIMITED', engine: 'keenable', status: 429, retryAfterMs: 120000 }));
    const result = await handler('test-search', { query: 'private query', revision });
    expect(result).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { engine: 'keenable', status: 429, retryAfterMs: 120000 } } });
    expect(result.error.message).toContain('saving a Keenable API key lifts it');
    expect(JSON.stringify(result)).not.toMatch(/private/);
  });

  test('sanitizes unknown failure codes and unavailable settings', async () => {
    executeSearch.mockRejectedValueOnce({ code: 'private-code', status: 999, engine: 'private-engine' });
    const result = await handler('test-search', { query: 'x', revision });
    expect(result).toMatchObject({ error: { code: 'SEARCH_FAILED', details: { elapsedMs: 0 } } });
    expect(JSON.stringify(result)).not.toMatch(/private-|999/);
    settings.describe.mockReturnValueOnce([]);
    expect(await handler('test-search', { query: 'x', revision })).toMatchObject({ error: { code: 'SETTINGS_UNAVAILABLE' } });
  });
});
